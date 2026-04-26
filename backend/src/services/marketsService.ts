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
 * - On-chain data: separate cron every 1 minute at :10; per-pool cache TTL 30m (onchainTtlMs)
 * - At merge time, on-chain cache is read (never blocks markets fetch)
 * - If on-chain data missing, fallback calculation for baseVariableBorrowRate
 */

import { fetchMarketsData, type MarketsPayload, type RuntimeReserveData } from '../../../dist/index.js';
import { BACKEND_CACHE_TTL_MS } from '../cacheTtl.js';
import { v4FatalConfig } from '../config.js';
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
      logger.info(`🔄 Starting markets refresh (v4Fatal=${v4FatalConfig.v4Fatal})...`);

      // Fetch markets from Aave API
      const payload = await withTimeout(
        fetchMarketsData({ v4Fatal: v4FatalConfig.v4Fatal }),
        MARKETS_FETCH_TIMEOUT_MS,
        'Markets fetch timeout'
      );

      if (payload.data.length === 0) {
        const previous = snapshot;
        if (previous) {
          const ageMs = Date.now() - previous.fetchedAt;
          if (ageMs <= BACKEND_CACHE_TTL_MS.marketsHardTtlMs) {
            logger.warn(
              `⚠️ Markets refresh returned empty dataset; keeping previous snapshot ` +
              `(age=${Math.round(ageMs / 1000)}s, hardTtl=${Math.round(
                BACKEND_CACHE_TTL_MS.marketsHardTtlMs / 1000
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

        // deficit: SDK value > on-chain RPC > default '0'
        if ((reserve as any).deficit) {
          // SDK already provided deficit — keep it
        } else if (onchainData?.deficit !== undefined) {
          (reserve as any).deficit = onchainData.deficit;
        } else {
          (reserve as any).deficit = '0';
        }

        // baseVariableBorrowRate: SDK value > on-chain RPC > fallback calculation
        if ((reserve as any).baseVariableBorrowRate) {
          // SDK already provided baseVariableBorrowRate — keep it
        } else if (onchainData?.baseVariableBorrowRate !== undefined) {
          (reserve as any).baseVariableBorrowRate = onchainData.baseVariableBorrowRate;
          mergedCount++;
        } else {
          // No SDK value and no on-chain RPC data — use fallback calculation
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
  hardTtlMs: number;
  ageMs: number | null;
  isTooStale: boolean;
} {
  if (!snapshot) {
    logger.warn('Markets snapshot not yet populated; returning null');
    return {
      payload: null,
      staleTimeMs: BACKEND_CACHE_TTL_MS.marketsSoftTtlMs,
      hardTtlMs: BACKEND_CACHE_TTL_MS.marketsHardTtlMs,
      ageMs: null,
      isTooStale: false,
    };
  }

  const ageMs = Date.now() - snapshot.fetchedAt;
    const isTooStale = ageMs > BACKEND_CACHE_TTL_MS.marketsHardTtlMs;
  if (isTooStale) {
    logger.warn(
      `Markets snapshot too stale to serve (age=${Math.round(ageMs / 1000)}s, max=${Math.round(
                BACKEND_CACHE_TTL_MS.marketsHardTtlMs / 1000
      )}s)`
    );
  }

  return {
    payload: isTooStale ? null : snapshot.payload,
    staleTimeMs: BACKEND_CACHE_TTL_MS.marketsSoftTtlMs,
      hardTtlMs: BACKEND_CACHE_TTL_MS.marketsHardTtlMs,
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

// ============================================================
// Option 3: Independent V3 and V4 snapshots
// ============================================================

import { fetchV3MarketsData, fetchV4MarketsData } from '../../../dist/index.js';

// Separate V3 and V4 snapshots with independent TTLs
let v3Snapshot: MarketsSnapshot | null = null;
let v4Snapshot: MarketsSnapshot | null = null;

// Separate refresh locks
let v3RefreshInProgress: Promise<MarketsSnapshot | null> | null = null;
let v4RefreshInProgress: Promise<MarketsSnapshot | null> | null = null;

/**
 * Merge on-chain data into a payload's reserves.
 * Shared helper for both V3 and V4 refresh paths.
 */
function mergeOnchainData(payload: MarketsPayload): {
  mergedCount: number;
  fallbackCount: number;
} {
  const onchainMap = getOnchainDataFromCache();
  let mergedCount = 0;
  let fallbackCount = 0;

  for (const reserve of payload.data) {
    const onchainData = onchainMap.get(reserve.reserveId);

    // deficit: SDK value > on-chain RPC > default '0'
    if ((reserve as any).deficit) {
      // SDK already provided deficit — keep it
    } else if (onchainData?.deficit !== undefined) {
      (reserve as any).deficit = onchainData.deficit;
    } else {
      (reserve as any).deficit = '0';
    }

    // baseVariableBorrowRate: SDK value > on-chain RPC > fallback calculation
    if ((reserve as any).baseVariableBorrowRate) {
      // SDK already provided baseVariableBorrowRate — keep it
    } else if (onchainData?.baseVariableBorrowRate !== undefined) {
      (reserve as any).baseVariableBorrowRate = onchainData.baseVariableBorrowRate;
      mergedCount++;
    } else {
      // No SDK value and no on-chain RPC data — use fallback calculation
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

  return { mergedCount, fallbackCount };
}

/**
 * Option 3: Refresh V3 snapshot only (independent of V4).
 * Called by V3-specific cron schedule.
 */
export async function refreshV3Snapshot(): Promise<MarketsSnapshot | null> {
  if (v3RefreshInProgress) {
    return v3RefreshInProgress;
  }

  v3RefreshInProgress = (async () => {
    try {
      const startTime = Date.now();
      logger.info('🔄 [V3] Starting V3-only markets refresh...');

      const payload = await withTimeout(
        fetchV3MarketsData(),
        MARKETS_FETCH_TIMEOUT_MS,
        'V3 markets fetch timeout'
      );

      if (payload.data.length === 0) {
        const previous = v3Snapshot;
        if (previous) {
          const ageMs = Date.now() - previous.fetchedAt;
          if (ageMs <= BACKEND_CACHE_TTL_MS.v3TtlMs) {
            logger.warn(
              `⚠️ [V3] V3 refresh returned empty dataset; keeping previous V3 snapshot ` +
              `(age=${Math.round(ageMs / 1000)}s)`
            );
            return previous;
          }
        }
        logger.error('❌ [V3] V3 refresh returned empty dataset and no fresh fallback snapshot');
        return null;
      }

      const { mergedCount, fallbackCount } = mergeOnchainData(payload);
      const cacheStatus = getOnchainCacheStatus();

      const newSnapshot: MarketsSnapshot = { payload, fetchedAt: Date.now() };
      v3Snapshot = newSnapshot;

      const elapsed = Date.now() - startTime;
      logger.info(
        `✅ [V3] V3 refresh: ${payload.data.length} reserves in ${elapsed}ms ` +
        `(on-chain: ${mergedCount} merged, ${fallbackCount} fallback, ` +
        `cache: ${cacheStatus.freshPools}/${cacheStatus.poolCount} fresh)`
      );

      return newSnapshot;
    } catch (error) {
      logger.error(`❌ [V3] V3 refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      return v3Snapshot; // Keep previous snapshot on error
    } finally {
      v3RefreshInProgress = null;
    }
  })();

  return v3RefreshInProgress;
}

/**
 * Option 3: Refresh V4 snapshot only (independent of V3).
 * Called by V4-specific cron schedule.
 */
export async function refreshV4Snapshot(): Promise<MarketsSnapshot | null> {
  if (v4RefreshInProgress) {
    return v4RefreshInProgress;
  }

  v4RefreshInProgress = (async () => {
    try {
      const startTime = Date.now();
      logger.info('🔄 [V4] Starting V4-only markets refresh...');

      const payload = await withTimeout(
        fetchV4MarketsData(),
        MARKETS_FETCH_TIMEOUT_MS,
        'V4 markets fetch timeout'
      );

      if (payload.data.length === 0) {
        const previous = v4Snapshot;
        if (previous) {
          const ageMs = Date.now() - previous.fetchedAt;
          if (ageMs <= BACKEND_CACHE_TTL_MS.v4TtlMs) {
            logger.warn(
              `⚠️ [V4] V4 refresh returned empty dataset; keeping previous V4 snapshot ` +
              `(age=${Math.round(ageMs / 1000)}s)`
            );
            return previous;
          }
        }
        // V4 empty is non-fatal — return null (API will serve V3 only)
        logger.warn('⚠️ [V4] V4 refresh returned empty dataset; no fallback available');
        return null;
      }

      const { mergedCount, fallbackCount } = mergeOnchainData(payload);
      const cacheStatus = getOnchainCacheStatus();

      const newSnapshot: MarketsSnapshot = { payload, fetchedAt: Date.now() };
      v4Snapshot = newSnapshot;

      const elapsed = Date.now() - startTime;
      logger.info(
        `✅ [V4] V4 refresh: ${payload.data.length} reserves in ${elapsed}ms ` +
        `(on-chain: ${mergedCount} merged, ${fallbackCount} fallback, ` +
        `cache: ${cacheStatus.freshPools}/${cacheStatus.poolCount} fresh)`
      );

      return newSnapshot;
    } catch (error) {
      logger.error(`❌ [V4] V4 refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      return v4Snapshot; // Keep previous snapshot on error
    } finally {
      v4RefreshInProgress = null;
    }
  })();

  return v4RefreshInProgress;
}

/**
 * Option 3: Get merged V3+V4 data for API response.
 * Merges both independent snapshots at read time.
 * Each snapshot has its own TTL and staleness check.
 */
export function getMergedV3V4Data(): {
  payload: MarketsPayload | null;
  v3AgeMs: number | null;
  v4AgeMs: number | null;
  v3IsTooStale: boolean;
  v4IsTooStale: boolean;
  v3ReserveCount: number;
  v4ReserveCount: number;
} {
  const now = Date.now();

  // Check V3 staleness
  let v3Data: RuntimeReserveData[] = [];
  let v3AgeMs: number | null = null;
  let v3IsTooStale = false;

  if (v3Snapshot) {
    v3AgeMs = now - v3Snapshot.fetchedAt;
    v3IsTooStale = v3AgeMs > BACKEND_CACHE_TTL_MS.v3TtlMs;
    if (!v3IsTooStale) {
      v3Data = v3Snapshot.payload.data;
    } else {
      logger.warn(
        `[V3] V3 snapshot too stale to serve (age=${Math.round(v3AgeMs / 1000)}s, ` +
        `max=${Math.round(BACKEND_CACHE_TTL_MS.v3TtlMs / 1000)}s)`
      );
    }
  }

  // Check V4 staleness
  let v4Data: RuntimeReserveData[] = [];
  let v4AgeMs: number | null = null;
  let v4IsTooStale = false;

  if (v4Snapshot) {
    v4AgeMs = now - v4Snapshot.fetchedAt;
    v4IsTooStale = v4AgeMs > BACKEND_CACHE_TTL_MS.v4TtlMs;
    if (!v4IsTooStale) {
      v4Data = v4Snapshot.payload.data;
    } else {
      logger.warn(
        `[V4] V4 snapshot too stale to serve (age=${Math.round(v4AgeMs / 1000)}s, ` +
        `max=${Math.round(BACKEND_CACHE_TTL_MS.v4TtlMs / 1000)}s)`
      );
    }
  }

  // Merge V3 + V4 data
  const mergedData = [...v3Data, ...v4Data];

  if (mergedData.length === 0) {
    return {
      payload: null,
      v3AgeMs,
      v4AgeMs,
      v3IsTooStale,
      v4IsTooStale,
      v3ReserveCount: 0,
      v4ReserveCount: 0,
    };
  }

  // Use the older timestamp for the merged payload
  const v3Timestamp = v3Snapshot?.payload._metadata.timestamp ?? '';
  const v4Timestamp = v4Snapshot?.payload._metadata.timestamp ?? '';
  const mergedTimestamp = v3Timestamp && v4Timestamp
    ? (v3Timestamp < v4Timestamp ? v3Timestamp : v4Timestamp)
    : (v3Timestamp || v4Timestamp || new Date().toISOString());

  return {
    payload: {
      _metadata: {
        timestamp: mergedTimestamp,
        version: '2.0-runtime-minimal-merged',
        dataCount: mergedData.length,
        profile: 'runtime-minimal',
      },
      data: mergedData,
    },
    v3AgeMs,
    v4AgeMs,
    v3IsTooStale,
    v4IsTooStale,
    v3ReserveCount: v3Data.length,
    v4ReserveCount: v4Data.length,
  };
}

/**
 * Option 3: Warmup both V3 and V4 caches.
 */
export async function warmSeparateV3V4Caches(): Promise<void> {
  await Promise.allSettled([
    refreshV3Snapshot(),
    refreshV4Snapshot(),
  ]);
}
