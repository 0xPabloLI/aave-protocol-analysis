/**
 * On-chain Data Service - Fetches data only available from on-chain RPC
 *
 * V3: Fetches `deficit` and `baseVariableBorrowRate` from UiPoolDataProvider.getReservesHumanized()
 * V4: Fetches per-spoke deficit from Hub.getSpokeDeficitRay(assetId, spoke)
 *     - Step 1: Hub.getAssetCount() + Hub.getAsset(assetId) → underlying→assetId mapping
 *     - Step 2: Hub.getSpokeDeficitRay(assetId, spoke) → per-spoke deficit (aligned with V3 reserve.deficit)
 *
 * Architecture:
 * - V3: one config per address-book entry (per pool/market), cache key = poolAddress
 * - V4: one config per Spoke, cache key = spokeAddress — per-spoke deficit = per-reserve deficit
 * - Merge key (V3): `${chainId}:${poolAddress}:${tokenAddress}`
 * - Merge key (V4): `${chainId}:${spokeAddress}:${tokenAddress}:${hubName}`
 * - Runs independently from markets fetch (async, non-blocking)
 * - Per-pool caching with 30-min TTL
 * - If RPC fails, cached data within TTL is used
 * - If no cached data, fields are absent (with fallback calculation for baseVariableBorrowRate)
 *
 * V4 RPC calls (optimized with Multicall3, pre-deployed at 0xcA11bde05977b6962E52E3F19a7a4e4f080A7e34):
 *   - Per Hub: 2 Multicall3 batches (1 getAssetCount + N getAsset → 1 batch, N getSpokeDeficitRay → 1 batch per spoke)
 *   - Hub asset mapping cached across spokes sharing the same Hub
 *   - Total: ~6 Multicall3 batches (3 Hubs × 2) + 10 spoke deficit batches ≈ 16 RPC calls (down from ~94)
 */

import { Contract, providers, utils } from 'ethers';
import { UiPoolDataProvider } from '@aave/contract-helpers';
import * as AaveAddressBook from '@aave-dao/aave-address-book';
import { getAaveRpcUrlsByChainId } from '@internal/aave-shared-config';
import { withTimeout } from '../lib/timeout.js';
import { ethProviderService } from './ethProviderService.js';
import { logger } from '../logger.js';
import { BACKEND_CACHE_TTL_MS } from '../cacheTtl.js';

const ONCHAIN_PER_RPC_TIMEOUT_MS = 15_000;

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

function buildPoolConfigs(): Map<string, OnchainConfig> {
  const configs = new Map<string, OnchainConfig>();

  for (const [key, value] of Object.entries(AaveAddressBook)) {
    if (!key.startsWith('AaveV3')) continue;
    if (!value || typeof value !== 'object') continue;
    if (key.includes('Sepolia') || key.includes('Fuji')) continue;

    const chainId = Number((value as any).CHAIN_ID);
    const poolAddress = normalizeAddress(String((value as any).POOL || ''));
    const uiPoolDataProviderAddress = (value as any).UI_POOL_DATA_PROVIDER;
    const poolAddressesProvider = (value as any).POOL_ADDRESSES_PROVIDER;

    if (!Number.isFinite(chainId) || chainId <= 0) continue;
    if (!poolAddress) continue;
    if (typeof uiPoolDataProviderAddress !== 'string') continue;
    if (typeof poolAddressesProvider !== 'string') continue;

    configs.set(poolAddress, {
      poolAddress,
      chainId,
      uiPoolDataProviderAddress,
      poolAddressesProvider,
      defaultRpcUrls: getAaveRpcUrlsByChainId(chainId),
    });
  }

  return configs;
}

const POOL_CONFIGS = buildPoolConfigs();

// ============================================================
// V4 Hub ABI (minimal: getAssetCount + getAsset + getSpokeDeficitRay)
// ============================================================
const V4_HUB_ABI = [
  {
    inputs: [],
    name: 'getAssetCount',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'assetId', type: 'uint256' }],
    name: 'getAsset',
    outputs: [
      {
        components: [
          { internalType: 'address', name: 'underlying', type: 'address' },
          { internalType: 'uint8', name: 'decimals', type: 'uint8' },
          { internalType: 'uint120', name: 'liquidity', type: 'uint120' },
          { internalType: 'uint120', name: 'swept', type: 'uint120' },
          { internalType: 'uint120', name: 'addedShares', type: 'uint120' },
          { internalType: 'uint120', name: 'drawnShares', type: 'uint120' },
          { internalType: 'uint120', name: 'premiumShares', type: 'uint120' },
          { internalType: 'int200', name: 'premiumOffsetRay', type: 'int200' },
          { internalType: 'uint120', name: 'drawnIndex', type: 'uint120' },
          { internalType: 'uint96', name: 'drawnRate', type: 'uint96' },
          { internalType: 'uint40', name: 'lastUpdateTimestamp', type: 'uint40' },
          { internalType: 'uint120', name: 'realizedFees', type: 'uint120' },
          { internalType: 'uint200', name: 'deficitRay', type: 'uint200' },
        ],
        internalType: 'struct IHub.Asset',
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'assetId', type: 'uint256' },
      { internalType: 'address', name: 'spoke', type: 'address' },
    ],
    name: 'getSpokeDeficitRay',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
];

// ============================================================
// Multicall3 ABI (pre-deployed on Ethereum at 0xcA11bde05977b6962E52E3F19a7a4e4f080A7e34)
// ============================================================
const MULTICALL3_ADDRESS = '0xcA11bde05977b6962E52E3F19a7a4e4f080A7e34';
const MULTICALL3_ABI = [
  {
    inputs: [{
      components: [
        { internalType: 'address', name: 'target', type: 'address' },
        { internalType: 'bool', name: 'allowFailure', type: 'bool' },
        { internalType: 'bytes', name: 'callData', type: 'bytes' },
      ],
      internalType: 'struct Multicall3.Call3[]',
      name: 'calls',
      type: 'tuple[]',
    }],
    name: 'aggregate3',
    outputs: [{
      components: [
        { internalType: 'bool', name: 'success', type: 'bool' },
        { internalType: 'bytes', name: 'returnData', type: 'bytes' },
      ],
      internalType: 'struct Multicall3.Result[]',
      name: 'returnData',
      type: 'tuple[]',
    }],
    stateMutability: 'view',
    type: 'function',
  },
];

const RAY = BigInt(10) ** BigInt(27);
const V4_HUB_INTERFACE = new utils.Interface(V4_HUB_ABI);
const MULTICALL3_INTERFACE = new utils.Interface(MULTICALL3_ABI);

// ============================================================
// V4 Spoke Config (auto-discovered from address-book AaveV4* entries)
// Need spoke address for getSpokeDeficitRay(assetId, spoke)
// ============================================================
interface V4SpokeConfig {
  spokeName: string;
  chainId: number;
  spokeAddress: string;
  hubAddress: string;
  hubName: string;
  defaultRpcUrls: string[];
}

const V4_SPOKE_TO_HUB: Record<string, string> = {
  MAIN_SPOKE: 'CORE_HUB',
  BLUECHIP_SPOKE: 'CORE_HUB',
  LIDO_ESPOKE: 'CORE_HUB',
  ETHERFI_ESPOKE: 'CORE_HUB',
  KELP_ESPOKE: 'CORE_HUB',
  ETHENA_CORRELATED_SPOKE: 'PLUS_HUB',
  ETHENA_ECOSYSTEM_SPOKE: 'PLUS_HUB',
  FOREX_SPOKE: 'PLUS_HUB',
  GOLD_SPOKE: 'PLUS_HUB',
  LOMBARD_BTC_SPOKE: 'PRIME_HUB',
};

function buildV4SpokeConfigs(): V4SpokeConfig[] {
  const configs: V4SpokeConfig[] = [];

  for (const [key, value] of Object.entries(AaveAddressBook)) {
    if (!key.startsWith('AaveV4')) continue;
    if (!value || typeof value !== 'object') continue;

    const chainId = Number((value as any).CHAIN_ID);
    if (!Number.isFinite(chainId) || chainId <= 0) continue;

    const hubs = (value as any).HUBS;
    const spokes = (value as any).SPOKES;
    if (!hubs || !spokes) continue;

    for (const [spokeKey, spokeAddr] of Object.entries(spokes as Record<string, any>)) {
      if (!spokeKey.endsWith('_SPOKE') && !spokeKey.endsWith('_ESPOKE')) continue;
      if (spokeKey === 'TREASURY_SPOKE') continue;
      if (typeof spokeAddr !== 'string') continue;

      const hubKey = V4_SPOKE_TO_HUB[spokeKey];
      if (!hubKey) continue;

      const hubAddr = hubs[hubKey];
      if (typeof hubAddr !== 'string') continue;

      configs.push({
        spokeName: spokeKey,
        chainId,
        spokeAddress: normalizeAddress(spokeAddr),
        hubAddress: normalizeAddress(hubAddr),
        hubName: hubKey,
        defaultRpcUrls: getAaveRpcUrlsByChainId(chainId),
      });
    }
  }

  return configs;
}

const V4_SPOKE_CONFIGS = buildV4SpokeConfigs();

const poolCache = new Map<string, ChainCacheEntry>();

const v4SpokeCache = new Map<string, ChainCacheEntry>();

let refreshInProgress: Promise<void> | null = null;

async function fetchAndCacheChain(config: OnchainConfig): Promise<boolean> {
  const rpcCandidates = ethProviderService.getProvidersForChain(config.chainId, config.defaultRpcUrls);
  logger.debug(
    `On-chain RPC order for ${config.poolAddress}: ${rpcCandidates.map((c) => c.rpcUrl).join(' -> ')}`
  );

  for (const { rpcUrl, provider } of rpcCandidates) {
    try {
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
        `On-chain fetch timeout for chain ${config.chainId} via ${rpcUrl}`
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

      poolCache.set(config.poolAddress, {
        data: chainData,
        updatedAt: Date.now(),
      });

      ethProviderService.reportProviderSuccess(config.chainId, rpcUrl);
      logger.debug(`On-chain fetch succeeded for ${config.poolAddress} via ${rpcUrl}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ethProviderService.reportProviderFailure(config.chainId, rpcUrl, message);
      logger.debug(`On-chain fetch failed for ${config.poolAddress} via ${rpcUrl}: ${message}`);
    }
  }

  logger.warn(`All RPC endpoints failed for ${config.poolAddress}, using cached data if available`);
  return false;
}

async function fetchAndCacheV4Spoke(
  config: V4SpokeConfig,
  hubAssetMapping: Map<string, Map<string, number>>
): Promise<boolean> {
  const rpcCandidates = ethProviderService.getProvidersForChain(config.chainId, config.defaultRpcUrls);

  for (const { rpcUrl, provider } of rpcCandidates) {
    try {
      let underlyingToAssetId = hubAssetMapping.get(config.hubAddress);
      if (!underlyingToAssetId) {
        underlyingToAssetId = await buildHubAssetMappingMulticall(provider, config.hubAddress, config.hubName, rpcUrl);
        if (underlyingToAssetId.size === 0) continue;
        hubAssetMapping.set(config.hubAddress, underlyingToAssetId);
      }

      const spokeData = new Map<string, OnchainReserveData>();
      const deficitCalls: { underlying: string; assetId: number; callData: string }[] = [];

      for (const [underlying, assetId] of underlyingToAssetId) {
        const callData = V4_HUB_INTERFACE.encodeFunctionData('getSpokeDeficitRay', [assetId, config.spokeAddress]);
        deficitCalls.push({ underlying, assetId, callData });
      }

      if (deficitCalls.length > 0) {
        const multicallCalls = deficitCalls.map((c) => ({
          target: config.hubAddress,
          allowFailure: true,
          callData: c.callData,
        }));

        try {
          const results = await executeMulticall3(provider, multicallCalls, rpcUrl);

          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const { underlying } = deficitCalls[i];
            if (!r.success) continue;

            try {
              const deficitRay = V4_HUB_INTERFACE.decodeFunctionResult('getSpokeDeficitRay', r.returnData)[0];
              const deficitRayStr = String(deficitRay);
              if (deficitRayStr !== '0') {
                try {
                  const deficitUnderlying = BigInt(deficitRayStr) / RAY;
                  spokeData.set(underlying, { deficit: deficitUnderlying.toString() });
                } catch {
                  spokeData.set(underlying, { deficit: deficitRayStr });
                }
              } else {
                spokeData.set(underlying, { deficit: '0' });
              }
            } catch (e) {
              logger.debug(`V4 Multicall3 decode getSpokeDeficitRay for ${underlying} failed: ${e}`);
            }
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logger.debug(`V4 Multicall3 deficit batch failed for ${config.spokeName}: ${msg}, falling back to serial`);

          const hubContract = new Contract(config.hubAddress, V4_HUB_ABI, provider);
          for (const [underlying, assetId] of underlyingToAssetId) {
            try {
              const deficitRay = await withTimeout(
                hubContract.getSpokeDeficitRay(assetId, config.spokeAddress),
                ONCHAIN_PER_RPC_TIMEOUT_MS,
                `V4 getSpokeDeficitRay(${assetId}, ${config.spokeName}) timeout`
              ) as any;
              const deficitRayStr = String(deficitRay);
              if (deficitRayStr !== '0') {
                try {
                  const deficitUnderlying = BigInt(deficitRayStr) / RAY;
                  spokeData.set(underlying, { deficit: deficitUnderlying.toString() });
                } catch {
                  spokeData.set(underlying, { deficit: deficitRayStr });
                }
              } else {
                spokeData.set(underlying, { deficit: '0' });
              }
            } catch (e2) {
              logger.debug(`V4 getSpokeDeficitRay(${assetId}, ${config.spokeName}) failed: ${e2}`);
            }
          }
        }
      }

      v4SpokeCache.set(config.spokeAddress, {
        data: spokeData,
        updatedAt: Date.now(),
      });

      ethProviderService.reportProviderSuccess(config.chainId, rpcUrl);
      logger.debug(`V4 on-chain fetch succeeded for ${config.spokeName} (${spokeData.size} assets) via ${rpcUrl}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ethProviderService.reportProviderFailure(config.chainId, rpcUrl, message);
      logger.debug(`V4 on-chain fetch failed for ${config.spokeName} via ${rpcUrl}: ${message}`);
    }
  }

  logger.warn(`All RPC endpoints failed for V4 ${config.spokeName}, using cached data if available`);
  return false;
}

const MAX_HUB_ASSET_COUNT = 200;

async function buildHubAssetMappingMulticall(
  provider: providers.Provider,
  hubAddress: string,
  hubName: string,
  rpcUrl: string
): Promise<Map<string, number>> {
  try {
    const mapping = await buildHubAssetMappingMulticallInner(provider, hubAddress, hubName, rpcUrl);
    if (mapping.size > 0) return mapping;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.debug(`V4 Multicall3 Hub mapping failed for ${hubName}: ${msg}, falling back to serial`);
  }

  return buildHubAssetMappingSerial(provider, hubAddress, hubName, rpcUrl);
}

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
    rpcUrl
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

  const assetResults = await executeMulticall3(provider, getAssetCalls, rpcUrl);

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
  const hubContract = new Contract(hubAddress, V4_HUB_ABI, provider);

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

async function executeMulticall3(
  provider: providers.Provider,
  calls: { target: string; allowFailure: boolean; callData: string }[],
  rpcUrl: string
): Promise<{ success: boolean; returnData: string }[]> {
  const multicall3 = new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);

  const rawResults = await withTimeout(
    multicall3.callStatic.aggregate3(calls),
    ONCHAIN_PER_RPC_TIMEOUT_MS,
    `V4 Multicall3.aggregate3 timeout via ${rpcUrl}`
  ) as { success: boolean; returnData: string }[];

  return rawResults.map((r) => ({
    success: r.success,
    returnData: r.returnData,
  }));
}

export async function refreshOnchainCache(): Promise<void> {
  if (refreshInProgress) {
    logger.debug('On-chain cache refresh already in progress, skipping');
    return;
  }

  refreshInProgress = (async () => {
    try {
      const startTime = Date.now();
      const poolAddrs = Array.from(POOL_CONFIGS.keys());

      logger.info(`p Refreshing on-chain cache for ${poolAddrs.length} V3 pools + ${V4_SPOKE_CONFIGS.length} V4 spokes...`);

      const v3Results = await Promise.allSettled(
        poolAddrs.map((poolAddr) => {
          const config = POOL_CONFIGS.get(poolAddr);
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
          const entry = poolCache.get(poolAddrs[i]);
          if (entry) v3TotalReserves += entry.data.size;
        } else {
          v3Fail++;
        }
      }

      const hubAssetMapping = new Map<string, Map<string, number>>();

      const v4Results = await Promise.allSettled(
        V4_SPOKE_CONFIGS.map((config) => fetchAndCacheV4Spoke(config, hubAssetMapping))
      );

      let v4Success = 0;
      let v4TotalAssets = 0;

      for (let i = 0; i < v4Results.length; i++) {
        const r = v4Results[i];
        if (r.status === 'fulfilled' && r.value) {
          v4Success++;
          const entry = v4SpokeCache.get(V4_SPOKE_CONFIGS[i].spokeAddress);
          if (entry) v4TotalAssets += entry.data.size;
        }
      }

      const elapsed = Date.now() - startTime;
      logger.info(
        `b On-chain cache: V3 ${v3TotalReserves} reserves from ${v3Success}/${poolAddrs.length} pools, ` +
        `V4 ${v4TotalAssets} assets from ${v4Success}/${V4_SPOKE_CONFIGS.length} spokes in ${elapsed}ms`
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
  for (const [poolAddress, entry] of poolCache) {
    const age = now - entry.updatedAt;
    if (age >= ttl) continue;
    const config = POOL_CONFIGS.get(poolAddress);
    if (!config) continue;
    for (const [tokenAddr, data] of entry.data) {
      const reserveId = `${config.chainId}:${poolAddress}:${tokenAddr}`;
      result.set(reserveId, data);
    }
  }

  // V4: key = `{chainId}:{spokeAddress}:{tokenAddr}:{hubName}`
  // Per-spoke deficit (getSpokeDeficitRay), semantically aligned with V3 reserve.deficit
  // Key format matches V4 reserveId — direct lookup, no fallback needed
  for (const v4Config of V4_SPOKE_CONFIGS) {
    const entry = v4SpokeCache.get(v4Config.spokeAddress);
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

function apyRatioToAprPercent(apyRatio: number): number {
  if (!Number.isFinite(apyRatio) || apyRatio <= -1) return 0;
  const aprDecimal = SECONDS_PER_YEAR * (Math.pow(1 + apyRatio, 1 / SECONDS_PER_YEAR) - 1);
  return Number.isFinite(aprDecimal) && aprDecimal >= 0 ? aprDecimal * 100 : 0;
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
    } else if (
      utilizationPct > optimalUtilization &&
      slopeAboveOptimal !== undefined &&
      Number.isFinite(slopeAboveOptimal)
    ) {
      const denom = 100 - optimalUtilization;
      if (denom <= 0) return 0;
      const excessRatio = (utilizationPct - optimalUtilization) / denom;
      const slope2Contribution = slopeAboveOptimal * excessRatio;
      const baseRate = borrowRatePct - slopeBelowOptimal - slope2Contribution;
      if (baseRate >= 0) return baseRate;
    }
  }

  return 0;
}