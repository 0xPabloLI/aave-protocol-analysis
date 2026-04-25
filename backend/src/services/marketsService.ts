/**
 * Markets Service - Cron-write/API-read-only pattern
 *
 * This service internalizes the data fetcher logic:
 * - Cron (every 1 minute) calls refreshMarketsSnapshot() to fetch fresh data
 * - API requests only read from the in-memory snapshot, never trigger fetches
 * - Startup warmup ensures data is available before server accepts requests
 * 
 * Architecture:
 * - Markets: cron every 1 minute (see updateScheduler) calls refreshMarketsSnapshot()
 * - On-chain data: separate cron every 1 minute at :10; per-pool cache TTL 30m (onchainCacheTtl)
 * - At merge time, on-chain cache is read (never blocks markets fetch)
 * - If on-chain data missing, fallback calculation for baseVariableBorrowRate
 */

import { fetchMarketsData, type MarketsPayload, type RuntimeReserveData } from '../../../dist/index.js';
import { BACKEND_CACHE_TTL_MS } from '../cacheTtl.js';
import { logger } from '../logger.js';
import {
  getOnchainDataFromCache,
  getOnchainCacheStatus,
  calculateBaseRateFallback,
  type OnchainReserveData,
} from './onchainDataService.js';

// Timeout for markets fetch (Aave API can be slow)
const MARKETS_FETCH_TIMEOUT_MS = 60_000; // 60 seconds

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

// Re-export types for other modules
export type { MarketsPayload, RuntimeReserveData };

interface MarketsSnapshot {
  payload: MarketsPayload;
  fetchedAt: number;
}

// In-memory snapshot (cron-write, API-read-only)
let snapshot: MarketsSnapshot | null = null;

// Refresh lock to prevent concurrent refreshes
let refreshInProgress: Promise<MarketsSnapshot> | null = null;

/**
 * Refresh the markets snapshot.
 * Called by cron and startup warmup.
 * Uses a lock to prevent concurrent refreshes.
 * 
 * Fetches markets from Aave API, then merges on-chain data from cache.
 * On-chain cache is maintained independently (async, non-blocking).
 */
export async function refreshMarketsSnapshot(): Promise<MarketsSnapshot> {
  // If refresh is already in progress, wait for it
  if (refreshInProgress) {
    return refreshInProgress;
  }

  refreshInProgress = (async () => {
    try {
      const startTime = Date.now();
      logger.info('🔄 Starting markets refresh...');

      // Fetch markets from Aave API
      const payload = await withTimeout(
        fetchMarketsData(),
        MARKETS_FETCH_TIMEOUT_MS,
        'Markets fetch timeout'
      );

      if (payload.data.length === 0) {
        const previous = snapshot;
        if (previous) {
          const ageMs = Date.now() - previous.fetchedAt;
          if (ageMs <= BACKEND_CACHE_TTL_MS.marketsServeHardStaleMax) {
            logger.warn(
              `⚠️ Markets refresh returned empty dataset; keeping previous snapshot ` +
              `(age=${Math.round(ageMs / 1000)}s, maxServeStale=${Math.round(
                BACKEND_CACHE_TTL_MS.marketsServeHardStaleMax / 1000
              )}s)`
            );
            return previous;
          }
        }

        throw new Error('Markets refresh returned empty dataset and no fresh fallback snapshot is available');
      }

      // Read on-chain data from cache (async, non-blocking)
      // Cache is maintained by separate cron job
      const onchainMap = getOnchainDataFromCache();
      const cacheStatus = getOnchainCacheStatus();

      let mergedCount = 0;
      let fallbackCount = 0;

      // Merge on-chain data by reserveId (marketName:chainId:tokenAddress)
      for (const reserve of payload.data) {
        const onchainData = onchainMap.get(reserve.reserveId);
        
        if (onchainData) {
          // Merge on-chain data
          if (onchainData.deficit !== undefined) {
            (reserve as any).deficit = onchainData.deficit;
          }
          if (onchainData.baseVariableBorrowRate !== undefined) {
            (reserve as any).baseVariableBorrowRate = onchainData.baseVariableBorrowRate;
          }
          mergedCount++;
        } else {
          // Apply fallback: deficit defaults to "0", baseVariableBorrowRate calculated
          (reserve as any).deficit = '0';
          
          const fallbackBaseRate = calculateBaseRateFallback(
            reserve.borrowApy,
            reserve.utilizationPct,
            reserve.optimalUsageRate,
            reserve.variableRateSlope1,
            reserve.variableRateSlope2
          );
          if (fallbackBaseRate !== null) {
            (reserve as any).baseVariableBorrowRate = fallbackBaseRate;
            fallbackCount++;
          }
        }
      }

      const newSnapshot: MarketsSnapshot = {
        payload,
        fetchedAt: Date.now(),
      };

      snapshot = newSnapshot;

      const elapsed = Date.now() - startTime;
      logger.info(
        `✅ Markets refresh: ${payload.data.length} reserves in ${elapsed}ms ` +
        `(on-chain: ${mergedCount} merged, ${fallbackCount} fallback, ` +
        `cache: ${cacheStatus.freshPools}/${cacheStatus.poolCount} fresh)`
      );

      return newSnapshot;
    } finally {
      refreshInProgress = null;
    }
  })();

  return refreshInProgress;
}

/**
 * Get the current markets snapshot.
 * API-read-only: never triggers a refresh.
 * Returns null if snapshot not yet populated (cold start before warmup).
 */
export function getMarketsSnapshot(): MarketsSnapshot | null {
  return snapshot;
}

/**
 * Get markets data for API response.
 * Returns the payload with staleness info.
 */
export function getMarketsData(): {
  payload: MarketsPayload | null;
  staleTimeMs: number;
  maxServeStaleMs: number;
  ageMs: number | null;
  isTooStale: boolean;
} {
  if (!snapshot) {
    logger.warn('Markets snapshot not yet populated; returning null');
    return {
      payload: null,
      staleTimeMs: BACKEND_CACHE_TTL_MS.marketsDataStaleThreshold,
      maxServeStaleMs: BACKEND_CACHE_TTL_MS.marketsServeHardStaleMax,
      ageMs: null,
      isTooStale: false,
    };
  }

  const ageMs = Date.now() - snapshot.fetchedAt;
    const isTooStale = ageMs > BACKEND_CACHE_TTL_MS.marketsServeHardStaleMax;
  if (isTooStale) {
    logger.warn(
      `Markets snapshot too stale to serve (age=${Math.round(ageMs / 1000)}s, max=${Math.round(
                BACKEND_CACHE_TTL_MS.marketsServeHardStaleMax / 1000
      )}s)`
    );
  }

  return {
    payload: isTooStale ? null : snapshot.payload,
    staleTimeMs: BACKEND_CACHE_TTL_MS.marketsDataStaleThreshold,
      maxServeStaleMs: BACKEND_CACHE_TTL_MS.marketsServeHardStaleMax,
    ageMs,
    isTooStale,
  };
}

/**
 * Warmup function for startup.
 * Ensures markets data is available before server accepts requests.
 */
export async function warmMarketsCache(): Promise<void> {
  await refreshMarketsSnapshot();
}
