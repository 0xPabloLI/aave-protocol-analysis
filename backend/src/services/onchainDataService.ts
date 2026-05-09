/**
 * On-chain Data Service - Fetches data only available from on-chain RPC
 *
 * Fetches `deficit` and `baseVariableBorrowRate` from UiPoolDataProvider.getReservesHumanized()
 * for all pools (all address-book markets including same-chain variants e.g. Ethereum main, Lido, EtherFi, Horizon).
 *
 * Architecture:
 * - One config per address-book entry (per pool/market), not per chainId
 * - Cache key for merge: reserveId = `${marketName}:${chainId}:${tokenAddress}` (matches SDK reserveId)
 * - Runs independently from markets fetch (async, non-blocking)
 * - Per-pool caching with 30-min TTL
 * - If RPC fails, cached data within TTL is used
 * - If no cached data, fields are absent (with fallback calculation for baseVariableBorrowRate)
 */

import { UiPoolDataProvider } from '@aave/contract-helpers';
import * as AaveAddressBook from '@aave-dao/aave-address-book';
import { getAaveRpcUrlsByChainId } from '@internal/aave-shared-config';
import { withTimeout } from '../lib/timeout.js';
import { ethProviderService } from './ethProviderService.js';
import { logger } from '../logger.js';
import { BACKEND_CACHE_TTL_MS } from '../cacheTtl.js';

const ONCHAIN_PER_RPC_TIMEOUT_MS = 15_000; // 15s timeout per RPC endpoint attempt

/**
 * On-chain reserve data - fields only available from RPC
 */
export interface OnchainReserveData {
  deficit?: string;
  baseVariableBorrowRate?: number; // percent (e.g., 0 means 0%)
}

/**
 * Convert a RAY (1e27 fixed-point) string to a percent number.
 * Uses BigInt scaling to retain ~6 decimal places of precision.
 */
function rayStringToPercent(rayStr: string): number | undefined {
  if (!rayStr) return undefined;
  try {
    const big = BigInt(rayStr);
    // big / 1e21 = percent × 1e6 (safe Number range for realistic rates)
    const microPct = big / 10n ** 21n;
    return Number(microPct) / 1e6;
  } catch {
    return undefined;
  }
}

/**
 * Per-chain cache entry with timestamp
 */
interface ChainCacheEntry {
  data: Map<string, OnchainReserveData>; // Map<tokenAddress, data>
  updatedAt: number;
}

interface OnchainConfig {
  poolKey: string; // address-book key (e.g. AaveV3Ethereum, AaveV3EthereumLido), matches SDK marketName
  chainId: number;
  chainName: string;
  uiPoolDataProviderAddress: string;
  poolAddressesProvider: string;
  defaultRpcUrls: string[];
}

function normalizeAddress(addr: string): string {
  return addr.toLowerCase().trim();
}

/** Build one config per address-book pool (all markets including same-chain variants). */
function buildPoolConfigs(): Map<string, OnchainConfig> {
  const configs = new Map<string, OnchainConfig>();

  for (const [key, value] of Object.entries(AaveAddressBook)) {
    if (!key.startsWith('AaveV3')) continue;
    if (!value || typeof value !== 'object') continue;

    if (key.includes('Sepolia') || key.includes('Fuji')) continue;

    const chainId = Number((value as any).CHAIN_ID);
    const uiPoolDataProviderAddress = (value as any).UI_POOL_DATA_PROVIDER;
    const poolAddressesProvider = (value as any).POOL_ADDRESSES_PROVIDER;

    if (!Number.isFinite(chainId) || chainId <= 0) continue;
    if (typeof uiPoolDataProviderAddress !== 'string') continue;
    if (typeof poolAddressesProvider !== 'string') continue;

    const chainName = key.replace(/^AaveV3/, '');
    configs.set(key, {
      poolKey: key,
      chainId,
      chainName,
      uiPoolDataProviderAddress,
      poolAddressesProvider,
      defaultRpcUrls: getAaveRpcUrlsByChainId(chainId),
    });
  }

  return configs;
}

const POOL_CONFIGS = buildPoolConfigs();

/**
 * Map address-book pool key to SDK market name when they differ (API returns different casing/name).
 * Used so getOnchainDataFromCache() emits reserveIds that match reserve.reserveId from the payload.
 */
const POOL_KEY_TO_SDK_MARKET_NAME: Record<string, string> = {
  AaveV3InkWhitelabel: 'AaveV3Ink',
  AaveV3MegaEth: 'AaveV3MegaETH',
  AaveV3ZkSync: 'AaveV3zkSync',
};

// Per-pool cache: poolKey (address-book key) -> ChainCacheEntry
const poolCache = new Map<string, ChainCacheEntry>();

// Refresh lock to prevent concurrent refreshes
let refreshInProgress: Promise<void> | null = null;

/**
 * Fetch on-chain data for a single chain and update its cache entry.
 */
async function fetchAndCacheChain(config: OnchainConfig): Promise<boolean> {
  const rpcCandidates = ethProviderService.getProvidersForChain(config.chainId, config.defaultRpcUrls);
  logger.debug(
    `On-chain RPC order for ${config.poolKey}: ${rpcCandidates.map((candidate) => candidate.rpcUrl).join(' -> ')}`
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
        
        // deficit from getReservesHumanized() (Aave v3.3.0+)
        if (reserve.deficit !== undefined && reserve.deficit !== null) {
          data.deficit = reserve.deficit?.toString?.() ?? String(reserve.deficit);
        }
        
        // baseVariableBorrowRate from interest rate strategy (RPC returns RAY → convert to percent)
        if (reserve.baseVariableBorrowRate !== undefined && reserve.baseVariableBorrowRate !== null) {
          const rayStr = reserve.baseVariableBorrowRate?.toString?.() ?? String(reserve.baseVariableBorrowRate);
          const pct = rayStringToPercent(rayStr);
          if (pct !== undefined) data.baseVariableBorrowRate = pct;
        }
        
        if (Object.keys(data).length > 0) {
          chainData.set(addr, data);
        }
      }
      
      poolCache.set(config.poolKey, {
        data: chainData,
        updatedAt: Date.now(),
      });

      ethProviderService.reportProviderSuccess(config.chainId, rpcUrl);
      logger.debug(`On-chain fetch succeeded for ${config.poolKey} via ${rpcUrl}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ethProviderService.reportProviderFailure(config.chainId, rpcUrl, message);
      logger.debug(`On-chain fetch failed for ${config.poolKey} via ${rpcUrl}: ${message}`);
    }
  }

  logger.warn(`All RPC endpoints failed for ${config.poolKey}, using cached data if available`);
  return false;
}

/**
 * Refresh on-chain data cache for all chains.
 * Called by cron every 1 minute (same as markets).
 *
 * Architecture:
 * - All pools fetch concurrently (no overall timeout)
 * - Each pool tries all RPC endpoints with 15s timeout per attempt
 * - When a pool succeeds, it immediately updates its cache entry
 * - Per-pool TTL is 30 minutes; stale entries excluded at read time
 */
export async function refreshOnchainCache(): Promise<void> {
  if (refreshInProgress) {
    logger.debug('On-chain cache refresh already in progress, skipping');
    return;
  }

  refreshInProgress = (async () => {
    try {
      const startTime = Date.now();
      const poolKeys = Array.from(POOL_CONFIGS.keys());

      logger.info(`🔗 Refreshing on-chain cache for ${poolKeys.length} pools (concurrent, no overall timeout)...`);

      const results = await Promise.allSettled(
        poolKeys.map((poolKey) => {
          const config = POOL_CONFIGS.get(poolKey);
          if (!config) return Promise.resolve(false);
          return fetchAndCacheChain(config);
        })
      );

      let successCount = 0;
      let failCount = 0;
      let totalReserves = 0;

      for (let i = 0; i < results.length; i++) {
        const poolKey = poolKeys[i];
        const result = results[i];
        if (result.status === 'fulfilled' && result.value) {
          successCount++;
          const entry = poolCache.get(poolKey);
          if (entry) totalReserves += entry.data.size;
        } else {
          failCount++;
        }
      }

      const elapsed = Date.now() - startTime;
      logger.info(`✅ On-chain cache refresh: ${totalReserves} reserves from ${successCount}/${poolKeys.length} pools in ${elapsed}ms`);
    } finally {
      refreshInProgress = null;
    }
  })();

  return refreshInProgress;
}

/**
 * Get cached on-chain data for all reserves.
 * Key = reserveId (marketName:chainId:tokenAddress) to match SDK payload.
 * Returns only data within TTL; expired entries are excluded.
 * Read-only; never triggers a fetch.
 */
export function getOnchainDataFromCache(): Map<string, OnchainReserveData> {
  const result = new Map<string, OnchainReserveData>();
  const now = Date.now();
  const ttl = BACKEND_CACHE_TTL_MS.onchainTtlMs;

  for (const [poolKey, entry] of poolCache) {
    const age = now - entry.updatedAt;
    if (age >= ttl) continue;
    const config = POOL_CONFIGS.get(poolKey);
    if (!config) continue;
    const marketName = POOL_KEY_TO_SDK_MARKET_NAME[poolKey] ?? poolKey;
    for (const [tokenAddr, data] of entry.data) {
      const reserveId = `${marketName}:${config.chainId}:${tokenAddr}`;
      result.set(reserveId, data);
    }
  }

  return result;
}

/**
 * Get cache status for logging/monitoring.
 */
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

  return {
    poolCount: poolCache.size,
    reserveCount,
    freshPools,
    stalePools,
    oldestUpdateMs: oldestUpdate ? now - oldestUpdate : null,
  };
}

// ============================================================
// Fallback calculation for baseVariableBorrowRate
// ============================================================

/** Seconds per year; must match Aave on-chain (365*24*3600). */
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

/**
 * Convert borrow APY (annual yield as ratio, e.g. 0.052 = 5.2%) to APR percent.
 * On-chain: 1+APY = (1 + APR/SECONDS_PER_YEAR)^SECONDS_PER_YEAR.
 * Hence APR = SECONDS_PER_YEAR * ((1+APY)^(1/SECONDS_PER_YEAR) - 1), then ×100 → percent.
 */
function apyRatioToAprPercent(apyRatio: number): number {
  if (!Number.isFinite(apyRatio) || apyRatio <= -1) return 0;
  const aprDecimal = SECONDS_PER_YEAR * (Math.pow(1 + apyRatio, 1 / SECONDS_PER_YEAR) - 1);
  return Number.isFinite(aprDecimal) && aprDecimal >= 0 ? aprDecimal * 100 : 0;
}

/**
 * Calculate baseVariableBorrowRate (percent number) from borrowApy using reverse formula.
 * Used when RPC data is unavailable.
 *
 * Inputs (all percent numbers, ratio for APY):
 * - borrowApyRatio: borrow APY as annual yield ratio (e.g. 0.052 = 5.2%/yr).
 * - utilizationPct: borrow usage percent (0-100); same as chain (excludes deficit).
 * - optimalUsageRate / variableRateSlope1 / variableRateSlope2: percent numbers.
 *
 * Forward formula (Aave V3 two-slope model, in percent space):
 * - If util <= optimal && optimal > 0:
 *     variableBorrowRate = baseRate + slope1 * (util / optimal)
 * - If util > optimal && optimal < 100:
 *     variableBorrowRate = baseRate + slope1 + slope2 * (util - optimal) / (100 - optimal)
 */
export function calculateBaseRateFallback(
  borrowApyRatio: number | null | undefined,
  utilizationPct: number | null | undefined,
  optimalUsageRate: number | undefined,
  variableRateSlope1: number | undefined,
  variableRateSlope2?: number
): number | null {
  if (borrowApyRatio === null || borrowApyRatio === undefined) {
    return null;
  }

  const borrowRatePct = apyRatioToAprPercent(borrowApyRatio);

  if (
    utilizationPct !== null &&
    utilizationPct !== undefined &&
    Number.isFinite(utilizationPct) &&
    optimalUsageRate !== undefined &&
    Number.isFinite(optimalUsageRate) &&
    variableRateSlope1 !== undefined &&
    Number.isFinite(variableRateSlope1)
  ) {
    if (utilizationPct <= optimalUsageRate && optimalUsageRate > 0) {
      // baseRate = borrowRate - slope1 * (util / optimal)
      const slope1Contribution = variableRateSlope1 * (utilizationPct / optimalUsageRate);
      const baseRate = borrowRatePct - slope1Contribution;
      if (baseRate >= 0) return baseRate;
    } else if (
      utilizationPct > optimalUsageRate &&
      variableRateSlope2 !== undefined &&
      Number.isFinite(variableRateSlope2)
    ) {
      // baseRate = borrowRate - slope1 - slope2 * (util - optimal) / (100 - optimal)
      const denom = 100 - optimalUsageRate;
      if (denom <= 0) return 0;
      const excessRatio = (utilizationPct - optimalUsageRate) / denom;
      const slope2Contribution = variableRateSlope2 * excessRatio;
      const baseRate = borrowRatePct - variableRateSlope1 - slope2Contribution;
      if (baseRate >= 0) return baseRate;
    }
  }

  return 0;
}
