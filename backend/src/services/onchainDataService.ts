/**
 * On-chain Data Service - Fetches data only available from on-chain RPC
 * 
 * Fetches `deficit` and `baseVariableBorrowRate` from UiPoolDataProvider.getReservesHumanized()
 * for all chains. These are the only data points not available from Aave API.
 * 
 * Architecture:
 * - Runs independently from markets fetch (async, non-blocking)
 * - Per-chain caching with 30-min TTL (on-chain data changes infrequently)
 * - Markets fetch reads from cache, never waits for fresh fetch
 * - If RPC fails, cached data within TTL is used
 * - If no cached data, fields are absent (with fallback calculation for baseVariableBorrowRate)
 */

import { UiPoolDataProvider } from '@aave/contract-helpers';
import * as AaveAddressBook from '@bgd-labs/aave-address-book';
import { getAavePublicRpcUrlsByChainId } from '@internal/aave-shared-config';
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

function buildChainConfigs(): Map<number, OnchainConfig> {
  const configs = new Map<number, OnchainConfig>();
  
  for (const [key, value] of Object.entries(AaveAddressBook)) {
    if (!key.startsWith('AaveV3')) continue;
    if (!value || typeof value !== 'object') continue;
    
    // Skip testnets (same filter as markets fetcher)
    if (key.includes('Sepolia') || key.includes('Fuji')) continue;
    
    const chainId = Number((value as any).CHAIN_ID);
    const uiPoolDataProviderAddress = (value as any).UI_POOL_DATA_PROVIDER;
    const poolAddressesProvider = (value as any).POOL_ADDRESSES_PROVIDER;
    
    if (!Number.isFinite(chainId) || chainId <= 0) continue;
    if (typeof uiPoolDataProviderAddress !== 'string') continue;
    if (typeof poolAddressesProvider !== 'string') continue;
    
    // Skip if already have this chain (prefer non-Lido/EtherFi markets)
    if (configs.has(chainId)) {
      if (/Lido|EtherFi/i.test(key)) continue;
    }
    
    const chainName = key.replace(/^AaveV3/, '');
    configs.set(chainId, {
      chainId,
      chainName,
      uiPoolDataProviderAddress,
      poolAddressesProvider,
      defaultRpcUrls: getAavePublicRpcUrlsByChainId(chainId),
    });
  }
  
  return configs;
}

const CHAIN_CONFIGS = buildChainConfigs();

// Per-chain cache: chainId -> ChainCacheEntry
const chainCache = new Map<number, ChainCacheEntry>();

// Refresh lock to prevent concurrent refreshes
let refreshInProgress: Promise<void> | null = null;

/**
 * Fetch on-chain data for a single chain and update its cache entry.
 */
async function fetchAndCacheChain(config: OnchainConfig): Promise<boolean> {
  const rpcCandidates = ethProviderService.getProvidersForChain(config.chainId, config.defaultRpcUrls);
  
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
      
      // Update cache for this chain
      chainCache.set(config.chainId, {
        data: chainData,
        updatedAt: Date.now(),
      });
      
      ethProviderService.reportProviderSuccess(config.chainId, rpcUrl);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ethProviderService.reportProviderFailure(config.chainId, rpcUrl, message);
      logger.debug(`On-chain fetch failed for chain ${config.chainId} via ${rpcUrl}: ${message}`);
    }
  }
  
  // All RPC endpoints failed for this chain
  logger.warn(`All RPC endpoints failed for chain ${config.chainId}, using cached data if available`);
  return false;
}

/**
 * Refresh on-chain data cache for all chains.
 * Called by cron every 1 minute (same as markets).
 * 
 * Architecture:
 * - All chains fetch concurrently (no overall timeout)
 * - Each chain tries all RPC endpoints with 15s timeout per attempt
 * - When a chain succeeds, it immediately updates its per-chain cache
 * - Per-chain TTL is 30 minutes; stale chains are excluded at read time
 */
export async function refreshOnchainCache(): Promise<void> {
  // If refresh is already in progress, skip (don't queue)
  // This prevents buildup if previous refresh is slow
  if (refreshInProgress) {
    logger.debug('On-chain cache refresh already in progress, skipping');
    return;
  }

  refreshInProgress = (async () => {
    try {
      const startTime = Date.now();
      const chainIds = Array.from(CHAIN_CONFIGS.keys());
      
      logger.info(`🔗 Refreshing on-chain cache for ${chainIds.length} chains (concurrent, no overall timeout)...`);
      
      // Fire all chains concurrently - no overall timeout
      // Each chain tries all its RPC endpoints with 15s per-RPC timeout
      const results = await Promise.allSettled(
        chainIds.map(chainId => {
          const config = CHAIN_CONFIGS.get(chainId);
          if (!config) return Promise.resolve(false);
          // No timeout wrapper here - fetchAndCacheChain handles per-RPC timeout
          // and will try ALL RPC endpoints before returning
          return fetchAndCacheChain(config);
        })
      );
      
      let successCount = 0;
      let failCount = 0;
      let totalReserves = 0;
      
      for (let i = 0; i < results.length; i++) {
        const chainId = chainIds[i];
        const result = results[i];
        if (result.status === 'fulfilled' && result.value) {
          successCount++;
          const entry = chainCache.get(chainId);
          if (entry) totalReserves += entry.data.size;
        } else {
          failCount++;
        }
      }
      
      const elapsed = Date.now() - startTime;
      logger.info(`✅ On-chain cache refresh: ${totalReserves} reserves from ${successCount}/${chainIds.length} chains in ${elapsed}ms`);
    } finally {
      refreshInProgress = null;
    }
  })();

  return refreshInProgress;
}

/**
 * Get cached on-chain data for all reserves.
 * Returns only data within TTL; expired entries are excluded.
 * This is read-only and never triggers a fetch.
 */
export function getOnchainDataFromCache(): Map<string, OnchainReserveData> {
  const result = new Map<string, OnchainReserveData>();
  const now = Date.now();
  const ttl = BACKEND_CACHE_TTL_MS.onchainCacheTtl;
  
  for (const [chainId, entry] of chainCache) {
    const age = now - entry.updatedAt;
    if (age < ttl) {
      // Cache is still valid
      for (const [tokenAddr, data] of entry.data) {
        const key = `${chainId}:${tokenAddr}`;
        result.set(key, data);
      }
    }
  }
  
  return result;
}

/**
 * Get cache status for logging/monitoring.
 */
export function getOnchainCacheStatus(): {
  chainCount: number;
  reserveCount: number;
  freshChains: number;
  staleChains: number;
  oldestUpdateMs: number | null;
} {
  const now = Date.now();
  const ttl = BACKEND_CACHE_TTL_MS.onchainCacheTtl;
  let freshChains = 0;
  let staleChains = 0;
  let reserveCount = 0;
  let oldestUpdate: number | null = null;
  
  for (const [, entry] of chainCache) {
    const age = now - entry.updatedAt;
    if (age < ttl) {
      freshChains++;
      reserveCount += entry.data.size;
    } else {
      staleChains++;
    }
    if (oldestUpdate === null || entry.updatedAt < oldestUpdate) {
      oldestUpdate = entry.updatedAt;
    }
  }
  
  return {
    chainCount: chainCache.size,
    reserveCount,
    freshChains,
    staleChains,
    oldestUpdateMs: oldestUpdate ? now - oldestUpdate : null,
  };
}

// ============================================================
// Fallback calculation for baseVariableBorrowRate
// ============================================================

const RAY = BigInt('1000000000000000000000000000'); // 1e27

/**
 * Calculate baseVariableBorrowRate from borrowApy using reverse formula.
 * This is used when RPC data is unavailable.
 * 
 * Forward formula (Aave V3):
 * If borrowUsageRate <= optimalUsageRate:
 *   variableBorrowRate = baseVariableBorrowRate + rayMul(variableRateSlope1, normalizedUsage)
 * 
 * Reverse (when usage is low, assuming normalizedUsage ≈ 0):
 *   baseVariableBorrowRate ≈ variableBorrowRate (APR in ray)
 * 
 * For more accuracy, we need utilization data to reverse the full formula.
 */
export function calculateBaseRateFallback(
  borrowApyPercent: number | null | undefined,
  utilizationPct: number | null | undefined,
  optimalUsageRateRay: string | undefined,
  variableRateSlope1Ray: string | undefined
): string | null {
  // If no borrowApy, can't calculate
  if (borrowApyPercent === null || borrowApyPercent === undefined) {
    return null;
  }
  
  // Convert APY% to APR in ray (approximate: for small values APY ≈ APR)
  // APY = (1 + APR/n)^n - 1, for continuous: APR ≈ ln(1 + APY)
  // For simplicity, use: APR ≈ APY (valid when APY < 20%)
  const aprDecimal = borrowApyPercent / 100; // e.g., 5.2% -> 0.052
  const borrowRateRay = BigInt(Math.floor(aprDecimal * 1e27));
  
  // If we have utilization and slope data, do proper reverse calculation
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
      
      // If utilization <= optimal (common case):
      // borrowRate = baseRate + slope1 * (util / optimal)
      // baseRate = borrowRate - slope1 * (util / optimal)
      if (utilRay <= optimalRay && optimalRay > 0n) {
        const normalizedUsage = (utilRay * RAY) / optimalRay;
        const slope1Contribution = (slope1Ray * normalizedUsage) / RAY;
        const baseRate = borrowRateRay - slope1Contribution;
        
        // Base rate should be >= 0
        if (baseRate >= 0n) {
          return baseRate.toString();
        }
      }
    } catch {
      // Fall through to simple approximation
    }
  }
  
  // Simple fallback: assume low utilization, base rate ≈ 0
  // Most Aave markets have baseVariableBorrowRate = 0
  return '0';
}
