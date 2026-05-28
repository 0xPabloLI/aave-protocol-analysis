/**
 * On-chain Data Service - Fetches data only available from on-chain RPC
 *
 * V3: Fetches `deficit` and `baseVariableBorrowRate` from UiPoolDataProvider.getReservesHumanized()
 * V4: Fetches per-spoke deficit from Hub.getSpokeDeficitRay(assetId, spoke)
 *     - Step 1: Hub.getAssetCount() + Hub.getAsset(assetId) → underlying→assetId mapping
 *     - Step 2: Hub.getSpokeDeficitRay(assetId, spoke) → per-spoke deficit (aligned with V3 reserve.deficit)
 *
 * Architecture:
 * - V3: one config per address-book entry (per pool/market), cache key = `${chainId}:${poolAddress}`
 * - V4: one config per Spoke, cache key = spokeAddress — per-spoke deficit = per-reserve deficit
 * - Merge key (V3): `${chainId}:${poolAddress}:${tokenAddress}`
 * - Merge key (V4): `${chainId}:${spokeAddress}:${tokenAddress}:${hubName}`
 * - Runs independently from markets fetch (async, non-blocking)
 * - Per-pool caching with 30-min TTL
 * - If RPC fails, cached data within TTL is used
 * - If no cached data, fields are absent (with fallback calculation for baseVariableBorrowRate)
 * Architecture:
 *
 * V4 RPC calls use Multicall3 with serial fallback:
 *   - Per Hub: 2 Multicall3 batches (getAssetCount + N getAsset → 1st batch, N deficit → 1 batch per spoke)
 *   - Multicall3 uses provider.call() (raw eth_call) to avoid ethers.js callStatic issues with payable functions
 *   - Hub asset mapping cached across spokes sharing the same Hub
 *   - Spokes fetched sequentially to avoid ECONNRESET from concurrent flooding
 *   - Target: ~16 Multicall3 batches (3 Hub × 2 + 10 spoke deficit) → ~35 RPC calls (down from ~241 serial)
 */

import { Contract, providers, utils } from 'ethers';
import { UiPoolDataProvider } from '@aave/contract-helpers';
import { getAaveRpcUrlsByChainId } from '@internal/aave-shared-config';
import { providerPool, executeMulticall3, withTimeout } from '@internal/aave-rpc-infra';
import { logger } from '../logger.js';
import { BACKEND_CACHE_TTL_MS } from '../cacheTtl.js';
import { V3_ENTRIES, V4_SPOKE_ENTRIES } from './addressBookRegistry.js';
import { V4_HUB_FULL_ABI } from '@internal/aave-rpc-infra';

const ONCHAIN_PER_RPC_TIMEOUT_MS = 15_000;
const HUB_MAPPING_TTL_MS = 10 * 60_000;

export interface OnchainReserveData {
  deficit?: string;
  baseVariableBorrowRate?: number;
}

function rayStringToPercent(rayStr: string): number | undefined {
  if (!rayStr) return undefined;
  try {
    const big = BigInt(rayStr);
    const microPct = big / 10n ** 21n;
    return Number(microPct) / 1e6;
  } catch {
    return undefined;
  }
}

interface ChainCacheEntry {
  data: Map<string, OnchainReserveData>;
  updatedAt: number;
}

interface OnchainConfig {
  poolAddress: string;
  chainId: number;
  uiPoolDataProviderAddress: string;
  poolAddressesProvider: string;
  defaultRpcUrls: string[];
}

function normalizeAddress(addr: string): string {
  return addr.toLowerCase().trim();
}

function poolConfigKey(chainId: number, poolAddress: string): string {
  return `${chainId}:${poolAddress}`;
}

export const POOL_CONFIGS = new Map<string, OnchainConfig>(
  V3_ENTRIES
    .filter((e) => e.uiPoolDataProviderAddress && e.poolAddressesProvider)
    .map((e) => [poolConfigKey(e.chainId, e.poolAddress), {
      poolAddress: e.poolAddress,
      chainId: e.chainId,
      uiPoolDataProviderAddress: e.uiPoolDataProviderAddress!,
      poolAddressesProvider: e.poolAddressesProvider!,
      defaultRpcUrls: getAaveRpcUrlsByChainId(e.chainId),
    }]),
);

const RAY = BigInt(10) ** BigInt(27);
export const V4_HUB_INTERFACE = new utils.Interface(V4_HUB_FULL_ABI);

export function processDeficitBatchResults(
  results: { success: boolean; returnData: string }[],
  underlyings: string[]
): Map<string, OnchainReserveData> {
  const spokeData = new Map<string, OnchainReserveData>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const underlying = underlyings[i];
    if (!r.success) {
      logger.debug(`Multicall3 getSpokeDeficitRay failed for ${underlying}, skipping`);
      continue;
    }
    let deficitRay: bigint;
    try {
      deficitRay = V4_HUB_INTERFACE.decodeFunctionResult('getSpokeDeficitRay', r.returnData)[0];
    } catch (e) {
      logger.debug(`Decode getSpokeDeficitRay failed for ${underlying}: ${e instanceof Error ? e.message : String(e)}, skipping`);
      continue;
    }
    const deficitRayStr = String(deficitRay);
    try {
      const deficitUnderlying = BigInt(deficitRayStr) / RAY;
      spokeData.set(underlying, { deficit: deficitUnderlying.toString() });
    } catch {
      spokeData.set(underlying, { deficit: deficitRayStr });
    }
  }
  return spokeData;
}

export function processDeficitSerialResult(
  deficitRay: bigint,
  underlying: string
): OnchainReserveData {
  const deficitRayStr = String(deficitRay);
  try {
    const deficitUnderlying = BigInt(deficitRayStr) / RAY;
    return { deficit: deficitUnderlying.toString() };
  } catch {
    return { deficit: deficitRayStr };
  }
}

// ============================================================
// Multicall3 — imported from @internal/aave-rpc-infra
// Uses provider.call() (raw eth_call) instead of contract.callStatic to avoid
// ethers.js v5 stateMutability issues: aggregate3 is payable, not view.
// ============================================================

// ============================================================
// V4 Spoke Config (runtime-derived from address-book via registry)
// Need spoke address for getSpokeDeficitRay(assetId, spoke)
// Multi-hub: BLUECHIP_SPOKE → 2 entries (CORE_HUB + PRIME_HUB)
// ============================================================
interface V4SpokeConfig {
  spokeName: string;
  chainId: number;
  spokeAddress: string;
  hubAddress: string;
  hubName: string;
  defaultRpcUrls: string[];
}

const V4_SPOKE_CONFIGS: V4SpokeConfig[] = V4_SPOKE_ENTRIES.map((e) => ({
  spokeName: e.spokeKey,
  chainId: e.chainId,
  spokeAddress: e.spokeAddress,
  hubAddress: e.hubAddress,
  hubName: e.hubKey,
  defaultRpcUrls: getAaveRpcUrlsByChainId(e.chainId),
}));

const poolCache = new Map<string, ChainCacheEntry>();

const v4SpokeCache = new Map<string, ChainCacheEntry>();

let refreshInProgress: Promise<void> | null = null;

let cachedHubMapping: Map<string, Map<string, number>> | null = null;
let cachedHubMappingAt = 0;

async function fetchAndCacheChain(config: OnchainConfig): Promise<boolean> {
  try {
    const chainData = await providerPool.executeWithFallback(
      config.chainId,
      config.defaultRpcUrls,
      {
        primary: async (provider: providers.Provider) => {
          const uiPoolDataProvider = new UiPoolDataProvider({
            uiPoolDataProviderAddress: config.uiPoolDataProviderAddress,
            provider,
            chainId: config.chainId,
          });

          const humanized = await withTimeout(
            uiPoolDataProvider.getReservesHumanized({
              lendingPoolAddressProvider: config.poolAddressesProvider,
            }),
            ONCHAIN_PER_RPC_TIMEOUT_MS,
            `On-chain fetch timeout for chain ${config.chainId}`
          );

          const reserves = (humanized as any).reservesData ?? [];
          const chainData = new Map<string, OnchainReserveData>();

          for (const reserve of reserves) {
            const addr = normalizeAddress(String(reserve.underlyingAsset || ''));
            if (!addr) continue;

            const data: OnchainReserveData = {};

            if (reserve.deficit !== undefined && reserve.deficit !== null) {
              data.deficit = reserve.deficit?.toString?.() ?? String(reserve.deficit);
            }

            if (reserve.baseVariableBorrowRate !== undefined && reserve.baseVariableBorrowRate !== null) {
              const rayStr = reserve.baseVariableBorrowRate?.toString?.() ?? String(reserve.baseVariableBorrowRate);
              const pct = rayStringToPercent(rayStr);
              if (pct !== undefined) data.baseVariableBorrowRate = pct;
            }

            if (Object.keys(data).length > 0) {
              chainData.set(addr, data);
            }
          }

          return chainData;
        },
      },
    );

    poolCache.set(poolConfigKey(config.chainId, config.poolAddress), {
      data: chainData,
      updatedAt: Date.now(),
    });

    return true;
  } catch {
    logger.warn(`All RPC endpoints failed for ${config.poolAddress}, using cached data if available`);
    return false;
  }
}

async function fetchSpokeDeficitMulticall3(
  provider: providers.Provider,
  hubAddress: string,
  spokeAddress: string,
  spokeName: string,
  underlyingToAssetId: Map<string, number>,
): Promise<Map<string, OnchainReserveData>> {
  const deficitCalls: { underlying: string; callData: string }[] = [];
  for (const [underlying, assetId] of underlyingToAssetId) {
    const callData = V4_HUB_INTERFACE.encodeFunctionData('getSpokeDeficitRay', [assetId, spokeAddress]);
    deficitCalls.push({ underlying, callData });
  }
  if (deficitCalls.length === 0) return new Map();

  const multicallCalls = deficitCalls.map((c) => ({
    target: hubAddress,
    allowFailure: true,
    callData: c.callData,
  }));
  const results = await executeMulticall3(provider, multicallCalls, { label: `V4 deficit batch for ${spokeName}` });
  const underlyings = deficitCalls.map((c) => c.underlying);
  return processDeficitBatchResults(results, underlyings);
}

async function fetchSpokeDeficitSerial(
  provider: providers.Provider,
  hubAddress: string,
  spokeAddress: string,
  spokeName: string,
  underlyingToAssetId: Map<string, number>,
): Promise<Map<string, OnchainReserveData>> {
  const spokeData = new Map<string, OnchainReserveData>();
  const hubContract = new Contract(hubAddress, V4_HUB_FULL_ABI, provider);
  for (const [underlying, assetId] of underlyingToAssetId) {
    const deficitRay = await withTimeout(
      hubContract.getSpokeDeficitRay(assetId, spokeAddress),
      ONCHAIN_PER_RPC_TIMEOUT_MS,
      `V4 getSpokeDeficitRay(${assetId}, ${spokeName}) timeout`
    ) as any;
    const result = processDeficitSerialResult(BigInt(String(deficitRay)), underlying);
    spokeData.set(underlying, result);
  }
  return spokeData;
}

async function fetchAndCacheV4Spoke(
  config: V4SpokeConfig,
  hubAssetMapping: Map<string, Map<string, number>>
): Promise<boolean> {
  const cacheKey = `${config.spokeAddress}:${config.hubName}`;

  let underlyingToAssetId = hubAssetMapping.get(config.hubAddress);
  if (!underlyingToAssetId) {
    try {
      underlyingToAssetId = await providerPool.executeWithFallback(
        config.chainId, config.defaultRpcUrls,
        {
          primary: (p: providers.Provider) => buildHubAssetMappingMulticallInner(p, config.hubAddress, config.hubName, 'safety-net'),
          fallback: (p: providers.Provider) => buildHubAssetMappingSerial(p, config.hubAddress, config.hubName, 'safety-net'),
        },
      );
    } catch {
      logger.warn(`All RPC endpoints failed for V4 hub mapping ${config.hubName}, using cached spoke data`);
      return false;
    }
    if (underlyingToAssetId.size > 0) {
      hubAssetMapping.set(config.hubAddress, underlyingToAssetId);
    }
  }

  if (underlyingToAssetId.size === 0) {
    v4SpokeCache.set(cacheKey, { data: new Map(), updatedAt: Date.now() });
    return true;
  }

  try {
    const spokeData = await providerPool.executeWithFallback(
      config.chainId,
      config.defaultRpcUrls,
      {
        primary: (p: providers.Provider) =>
          fetchSpokeDeficitMulticall3(p, config.hubAddress, config.spokeAddress, config.spokeName, underlyingToAssetId!),
        fallback: (p: providers.Provider) =>
          fetchSpokeDeficitSerial(p, config.hubAddress, config.spokeAddress, config.spokeName, underlyingToAssetId!),
      },
    );

    v4SpokeCache.set(cacheKey, { data: spokeData, updatedAt: Date.now() });
    return true;
  } catch {
    logger.warn(`All RPC endpoints failed for V4 ${config.spokeName}, using cached data if available`);
    return false;
  }
}

const MAX_HUB_ASSET_COUNT = 200;

async function buildHubAssetMappingMulticallInner(
  provider: providers.Provider,
  hubAddress: string,
  hubName: string,
  rpcUrl: string
): Promise<Map<string, number>> {
  const mapping = new Map<string, number>();

  const getAssetCountCalldata = V4_HUB_INTERFACE.encodeFunctionData('getAssetCount');
  const results = await executeMulticall3(
    provider,
    [{ target: hubAddress, allowFailure: false, callData: getAssetCountCalldata }],
    { label: `V4 getAssetCount for ${hubName} via ${rpcUrl}` }
  );

  if (!results[0].success) {
    logger.debug(`V4 Multicall3 getAssetCount failed for ${hubName}`);
    return mapping;
  }

  const assetCountBN = V4_HUB_INTERFACE.decodeFunctionResult('getAssetCount', results[0].returnData)[0];
  const assetCount = Number(assetCountBN);

  if (assetCount > MAX_HUB_ASSET_COUNT) {
    logger.warn(`V4 Hub ${hubName} reports ${assetCount} assets (>${MAX_HUB_ASSET_COUNT}), capping to prevent excessive RPC load`);
    return mapping;
  }

  const getAssetCalls = [];
  for (let assetId = 0; assetId < assetCount; assetId++) {
    const callData = V4_HUB_INTERFACE.encodeFunctionData('getAsset', [assetId]);
    getAssetCalls.push({ target: hubAddress, allowFailure: true, callData });
  }

  if (getAssetCalls.length === 0) return mapping;

  const assetResults = await executeMulticall3(provider, getAssetCalls, { label: `V4 getAsset batch for ${hubName} via ${rpcUrl}` });

  for (let assetId = 0; assetId < assetResults.length; assetId++) {
    const r = assetResults[assetId];
    if (!r.success) continue;
    try {
      const asset = V4_HUB_INTERFACE.decodeFunctionResult('getAsset', r.returnData)[0];
      const underlying = normalizeAddress(String(asset.underlying || ''));
      if (underlying) mapping.set(underlying, assetId);
    } catch (e) {
      logger.debug(`V4 Multicall3 decode getAsset(${assetId}) failed for ${hubName}: ${e}`);
    }
  }

  if (mapping.size === 0 && assetCount > 0) {
    logger.warn(`V4 Multicall3 Hub mapping for ${hubName}: 0/${assetCount} assets decoded successfully — possible ABI mismatch`);
  } else {
    logger.debug(`V4 Multicall3 Hub mapping for ${hubName}: ${mapping.size} assets (1 + ${assetCount} calls → 2 Multicall3 batches)`);
  }

  return mapping;
}

async function buildHubAssetMappingSerial(
  provider: providers.Provider,
  hubAddress: string,
  hubName: string,
  rpcUrl: string
): Promise<Map<string, number>> {
  const mapping = new Map<string, number>();
  const hubContract = new Contract(hubAddress, V4_HUB_FULL_ABI, provider);

  try {
    const assetCountBN = await withTimeout(
      hubContract.getAssetCount(),
      ONCHAIN_PER_RPC_TIMEOUT_MS,
      `V4 serial getAssetCount timeout for ${hubName} via ${rpcUrl}`
    ) as any;
    const assetCount = Number(assetCountBN);

    if (assetCount > MAX_HUB_ASSET_COUNT) {
      logger.warn(`V4 Hub ${hubName} reports ${assetCount} assets (>${MAX_HUB_ASSET_COUNT}), capping to prevent excessive RPC load`);
      return mapping;
    }

    for (let assetId = 0; assetId < assetCount; assetId++) {
      try {
        const asset = await withTimeout(
          hubContract.getAsset(assetId),
          ONCHAIN_PER_RPC_TIMEOUT_MS,
          `V4 serial getAsset(${assetId}) timeout for ${hubName}`
        ) as any;
        const underlying = normalizeAddress(String(asset.underlying || ''));
        if (underlying) mapping.set(underlying, assetId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.debug(`V4 serial getAsset(${assetId}) failed for ${hubName}: ${msg}`);
      }
    }

    if (mapping.size === 0 && assetCount > 0) {
      logger.warn(`V4 serial Hub mapping for ${hubName}: 0/${assetCount} assets decoded — possible ABI mismatch`);
    } else {
      logger.debug(`V4 serial Hub mapping for ${hubName}: ${mapping.size} assets via ${1 + assetCount} serial calls`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.debug(`V4 serial getAssetCount failed for ${hubName}: ${msg}`);
  }

  return mapping;
}

export async function refreshOnchainCache(): Promise<void> {
  if (refreshInProgress) {
    logger.debug('On-chain cache refresh already in progress, skipping');
    return;
  }

  refreshInProgress = (async () => {
    try {
      const startTime = Date.now();
      const poolKeys = Array.from(POOL_CONFIGS.keys());

      logger.info(`[onchain] Refreshing cache for ${poolKeys.length} V3 pools + ${V4_SPOKE_CONFIGS.length} V4 spokes...`);

      const v3Results = await Promise.allSettled(
        poolKeys.map((poolKey) => {
          const config = POOL_CONFIGS.get(poolKey);
          if (!config) return Promise.resolve(false);
          return fetchAndCacheChain(config);
        })
      );

      let v3Success = 0;
      let v3Fail = 0;
      let v3TotalReserves = 0;

      for (let i = 0; i < v3Results.length; i++) {
        const r = v3Results[i];
        if (r.status === 'fulfilled' && r.value) {
          v3Success++;
          const entry = poolCache.get(poolKeys[i]);
          if (entry) v3TotalReserves += entry.data.size;
        } else {
          v3Fail++;
        }
      }

      const now = Date.now();
      let hubAssetMapping: Map<string, Map<string, number>>;

      if (cachedHubMapping && (now - cachedHubMappingAt) < HUB_MAPPING_TTL_MS) {
        hubAssetMapping = cachedHubMapping;
        logger.debug(`[onchain] Hub mapping TTL fresh, using cached (${cachedHubMapping.size} hubs)`);
      } else {
        hubAssetMapping = new Map();
        for (const config of V4_SPOKE_CONFIGS) {
          if (hubAssetMapping.has(config.hubAddress)) continue;
          try {
            const mapping = await providerPool.executeWithFallback(
              config.chainId,
              config.defaultRpcUrls,
              {
                primary: (p: providers.Provider) => buildHubAssetMappingMulticallInner(p, config.hubAddress, config.hubName, 'pre-build'),
                fallback: (p: providers.Provider) => buildHubAssetMappingSerial(p, config.hubAddress, config.hubName, 'pre-build'),
              },
            );
            if (mapping.size > 0) {
              hubAssetMapping.set(config.hubAddress, mapping);
            }
          } catch {
            logger.warn(`All RPCs failed for hub mapping ${config.hubName}`);
          }
        }
        cachedHubMapping = hubAssetMapping;
        cachedHubMappingAt = now;
      }

      // Fetch V4 spokes sequentially to avoid overwhelming the RPC.
      // Previously Promise.allSettled sent 11 spokes × 15+ assets = ~187 concurrent
      // eth_calls to a single RPC, causing ECONNRESET on budget endpoints.
      let v4TotalAssets = 0;
      let v4Success = 0;
      let v4Fail = 0;

      for (const config of V4_SPOKE_CONFIGS) {
        // Each spoke already uses the pre-built hubAssetMapping (no redundant calls)
        const ok = await fetchAndCacheV4Spoke(config, hubAssetMapping);
        if (ok) {
          v4Success++;
          const entry = v4SpokeCache.get(`${config.spokeAddress}:${config.hubName}`);
          if (entry) v4TotalAssets += entry.data.size;
        } else {
          v4Fail++;
        }
      }

      const elapsed = Date.now() - startTime;
      logger.info(
        `[onchain] V3 ${v3TotalReserves} reserves from ${v3Success}/${poolKeys.length} pools, ` +
        `V4 ${v4TotalAssets} assets from ${v4Success}/${V4_SPOKE_CONFIGS.length} spokes (${v4Fail} failed) in ${elapsed}ms`
      );
    } finally {
      refreshInProgress = null;
    }
  })();

  return refreshInProgress;
}

export function getOnchainDataFromCache(): Map<string, OnchainReserveData> {
  const result = new Map<string, OnchainReserveData>();
  const now = Date.now();
  const ttl = BACKEND_CACHE_TTL_MS.onchainTtlMs;

  // V3: key = `${chainId}:${poolAddress}:${tokenAddr}`
  for (const [poolKey, entry] of poolCache) {
    const age = now - entry.updatedAt;
    if (age >= ttl) continue;
    const config = POOL_CONFIGS.get(poolKey);
    if (!config) continue;
    for (const [tokenAddr, data] of entry.data) {
      const reserveId = `${config.chainId}:${config.poolAddress}:${tokenAddr}`;
      result.set(reserveId, data);
    }
  }

  // V4: key = `{chainId}:{spokeAddress}:{tokenAddr}:{hubName}`
  // Per-spoke deficit (getSpokeDeficitRay), semantically aligned with V3 reserve.deficit
  // Key format matches V4 reserveId — direct lookup, no fallback needed
  for (const v4Config of V4_SPOKE_CONFIGS) {
    const entry = v4SpokeCache.get(`${v4Config.spokeAddress}:${v4Config.hubName}`);
    if (!entry) continue;
    const age = now - entry.updatedAt;
    if (age >= ttl) continue;
    for (const [tokenAddr, data] of entry.data) {
      const key = `${v4Config.chainId}:${v4Config.spokeAddress}:${tokenAddr}:${v4Config.hubName}`;
      result.set(key, data);
    }
  }

  return result;
}

export function getOnchainCacheStatus(): {
  poolCount: number;
  reserveCount: number;
  freshPools: number;
  stalePools: number;
  oldestUpdateMs: number | null;
} {
  const now = Date.now();
  const ttl = BACKEND_CACHE_TTL_MS.onchainTtlMs;
  let freshPools = 0;
  let stalePools = 0;
  let reserveCount = 0;
  let oldestUpdate: number | null = null;

  for (const [, entry] of poolCache) {
    const age = now - entry.updatedAt;
    if (age < ttl) {
      freshPools++;
      reserveCount += entry.data.size;
    } else {
      stalePools++;
    }
    if (oldestUpdate === null || entry.updatedAt < oldestUpdate) {
      oldestUpdate = entry.updatedAt;
    }
  }

  for (const [, entry] of v4SpokeCache) {
    const age = now - entry.updatedAt;
    if (age < ttl) {
      freshPools++;
      reserveCount += entry.data.size;
    } else {
      stalePools++;
    }
    if (oldestUpdate === null || entry.updatedAt < oldestUpdate) {
      oldestUpdate = entry.updatedAt;
    }
  }

  return {
    poolCount: poolCache.size + v4SpokeCache.size,
    reserveCount,
    freshPools,
    stalePools,
    oldestUpdateMs: oldestUpdate ? now - oldestUpdate : null,
  };
}

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

function apyRatioToAprPercent(apyRatio: number): number | null {
  if (!Number.isFinite(apyRatio) || apyRatio <= -1) return null;
  const aprDecimal = SECONDS_PER_YEAR * (Math.pow(1 + apyRatio, 1 / SECONDS_PER_YEAR) - 1);
  return Number.isFinite(aprDecimal) && aprDecimal >= 0 ? aprDecimal * 100 : null;
}

export function calculateBaseRateFallback(
  borrowApyRatio: number | null | undefined,
  utilizationPct: number | null | undefined,
  optimalUtilization: number | undefined,
  slopeBelowOptimal: number | undefined,
  slopeAboveOptimal?: number
): number | null {
  if (borrowApyRatio === null || borrowApyRatio === undefined) {
    return null;
  }

  const borrowRatePct = apyRatioToAprPercent(borrowApyRatio);
  if (borrowRatePct === null) return null;

  if (
    utilizationPct !== null &&
    utilizationPct !== undefined &&
    Number.isFinite(utilizationPct) &&
    optimalUtilization !== undefined &&
    Number.isFinite(optimalUtilization) &&
    slopeBelowOptimal !== undefined &&
    Number.isFinite(slopeBelowOptimal)
  ) {
    if (utilizationPct <= optimalUtilization && optimalUtilization > 0) {
      const slope1Contribution = slopeBelowOptimal * (utilizationPct / optimalUtilization);
      const baseRate = borrowRatePct - slope1Contribution;
      if (baseRate >= 0) return baseRate;
      return null;
    } else if (
      utilizationPct > optimalUtilization &&
      slopeAboveOptimal !== undefined &&
      Number.isFinite(slopeAboveOptimal)
    ) {
      const denom = 100 - optimalUtilization;
      if (denom <= 0) return null;
      const excessRatio = (utilizationPct - optimalUtilization) / denom;
      const slope2Contribution = slopeAboveOptimal * excessRatio;
      const baseRate = borrowRatePct - slopeBelowOptimal - slope2Contribution;
      if (baseRate >= 0) return baseRate;
      return null;
    }
  }

  return null;
}