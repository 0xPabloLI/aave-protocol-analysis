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
import * as AaveAddressBook from '@bgd-labs/aave-address-book';
import { getAaveRpcUrlsByChainId } from '@internal/aave-shared-config';
import { ethProviderService } from './ethProviderService.js';
import { logger } from '../logger.js';
import { BACKEND_CACHE_TTL_MS } from '../cacheTtl.js';

const ONCHAIN_PER_RPC_TIMEOUT_MS = 15_000; // 15s timeout per RPC endpoint attempt

/**
 * On-chain reserve data - fields only available from RPC
 */
export interface OnchainReserveData {
  deficit?: string;
  baseVariableBorrowRate?: string;
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

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
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
        
        // baseVariableBorrowRate from interest rate strategy
        if (reserve.baseVariableBorrowRate !== undefined && reserve.baseVariableBorrowRate !== null) {
          data.baseVariableBorrowRate = reserve.baseVariableBorrowRate?.toString?.() ?? String(reserve.baseVariableBorrowRate);
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

const RAY = BigInt('1000000000000000000000000000'); // 1e27

/** Seconds per year; must match Aave on-chain (365*24*3600). */
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

/**
 * Convert borrow APY (annual yield as ratio, e.g. 0.052 = 5.2%) to APR in RAY using the inverse
 * of chain per-second compounding.
 * On-chain: ratePerSecond = rateRay/RAY / SECONDS_PER_YEAR; index compounds as
 * (1 + ratePerSecond)^exp over exp seconds, so 1+APY = (1 + APR/SECONDS_PER_YEAR)^SECONDS_PER_YEAR.
 * Hence APR = SECONDS_PER_YEAR * ((1+APY)^(1/SECONDS_PER_YEAR) - 1).
 */
function apyRatioToAprRay(apyRatio: number): bigint {
  const apyDecimal = apyRatio;
  if (!Number.isFinite(apyDecimal) || apyDecimal <= -1) return 0n;
  const onePlusApy = 1 + apyDecimal;
  const aprDecimal =
    SECONDS_PER_YEAR * (Math.pow(onePlusApy, 1 / SECONDS_PER_YEAR) - 1);
  if (!Number.isFinite(aprDecimal) || aprDecimal < 0) return 0n;
  return BigInt(Math.floor(aprDecimal * 1e27));
}

/**
 * Calculate baseVariableBorrowRate from borrowApy using reverse formula.
 * Used when RPC data is unavailable.
 *
 * Inputs:
 * - borrowApyRatio: borrow APY as annual yield ratio (e.g. 0.052). Converted to APR in RAY via inverse of per-second compounding.
 * - utilizationPct: borrow usage in % = totalDebt / (availableLiquidity + totalDebt). Same as chain; deficit is not included.
 * - This function does not use reserve size; only utilization and rate params. Uses this reserve's slopes/optimal (same market).
 *
 * Forward formula (Aave V3 two-slope model):
 * - If borrowUsageRate <= optimalUsageRate:
 *     variableBorrowRate = baseRate + slope1 * (util / optimal)
 * - If borrowUsageRate > optimalUsageRate:
 *     excessRatio = (util - optimal) / (RAY - optimal)
 *     variableBorrowRate = baseRate + slope1 + slope2 * excessRatio
 */
export function calculateBaseRateFallback(
  borrowApyRatio: number | null | undefined,
  utilizationPct: number | null | undefined,
  optimalUsageRateRay: string | undefined,
  variableRateSlope1Ray: string | undefined,
  variableRateSlope2Ray?: string
): string | null {
  if (borrowApyRatio === null || borrowApyRatio === undefined) {
    return null;
  }

  const borrowRateRay = apyRatioToAprRay(borrowApyRatio);

  if (
    utilizationPct !== null &&
    utilizationPct !== undefined &&
    optimalUsageRateRay &&
    variableRateSlope1Ray
  ) {
    try {
      const utilRay = BigInt(Math.floor((utilizationPct / 100) * 1e27));
      const optimalRay = BigInt(optimalUsageRateRay);
      const slope1Ray = BigInt(variableRateSlope1Ray);

      if (utilRay <= optimalRay && optimalRay > 0n) {
        // baseRate = borrowRate - slope1 * (util / optimal)
        const normalizedUsage = (utilRay * RAY) / optimalRay;
        const slope1Contribution = (slope1Ray * normalizedUsage) / RAY;
        const baseRate = borrowRateRay - slope1Contribution;
        if (baseRate >= 0n) return baseRate.toString();
      } else if (utilRay > optimalRay && variableRateSlope2Ray) {
        // baseRate = borrowRate - slope1 - slope2 * excessRatio
        // excessRatio = (util - optimal) / (RAY - optimal)
        const slope2Ray = BigInt(variableRateSlope2Ray);
        const denom = RAY - optimalRay;
        if (denom <= 0n) return '0';
        const excessRatio = ((utilRay - optimalRay) * RAY) / denom;
        const slope2Contribution = (slope2Ray * excessRatio) / RAY;
        const baseRate = borrowRateRay - slope1Ray - slope2Contribution;
        if (baseRate >= 0n) return baseRate.toString();
      }
    } catch {
      // fall through
    }
  }

  return '0';
}
