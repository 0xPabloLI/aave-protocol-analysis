/**
 * Markets Service - Cron-write/API-read-only pattern
 *
 * This service internalizes the data fetcher logic:
 * - Cron (every 1 minute) calls refreshMarketsSnapshot() to fetch fresh data
 * - API requests only read from the in-memory snapshot, never trigger fetches
 * - Startup warmup ensures data is available before server accepts requests
 * 
 * Architecture (single fetchedAt):
 * - Parallel fetch: Aave API (markets) + RPC (deficit only)
 * - Merge deficit into markets data at write time
 * - If deficit fetch fails, markets still available (graceful degradation)
 */

import { fetchMarketsPayload, type MarketsPayload, type RuntimeReserveData } from '../../../dist/index.js';
import { BACKEND_CACHE_TTL_MS } from '../cacheTtl.js';
import { logger } from '../logger.js';
import { fetchAllDeficits } from './deficitService.js';

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

// Deficit cache - persists across refreshes for graceful degradation
interface DeficitCache {
  data: Map<string, string>;
  fetchedAt: number;
}

// In-memory snapshot (cron-write, API-read-only)
let snapshot: MarketsSnapshot | null = null;

// Deficit cache - updated on successful fetch, used when fresh fetch fails
let deficitCache: DeficitCache | null = null;

// Refresh lock to prevent concurrent refreshes
let refreshInProgress: Promise<MarketsSnapshot> | null = null;

/**
 * Refresh the markets snapshot.
 * Called by cron and startup warmup.
 * Uses a lock to prevent concurrent refreshes.
 * 
 * Fetches markets from Aave API and deficit from RPC in parallel.
 * Single fetchedAt ensures consistent staleness tracking.
 */
export async function refreshMarketsSnapshot(): Promise<MarketsSnapshot> {
  // If refresh is already in progress, wait for it
  if (refreshInProgress) {
    return refreshInProgress;
  }

  refreshInProgress = (async () => {
    try {
      const startTime = Date.now();
      logger.info('🔄 Starting unified markets + deficit refresh...');

      // Parallel fetch: markets from API, deficit from RPC
      // Both have independent timeouts for graceful degradation
      const [marketsResult, deficitResult] = await Promise.allSettled([
        withTimeout(fetchMarketsPayload(), MARKETS_FETCH_TIMEOUT_MS, 'Markets fetch timeout'),
        fetchAllDeficits(), // Has internal 15s timeout per chain
      ]);

      // Markets is required - if it fails, don't update snapshot
      if (marketsResult.status === 'rejected') {
        logger.error(`Markets fetch failed: ${marketsResult.reason}`);
        throw marketsResult.reason;
      }

      const payload = marketsResult.value;
      
      // Deficit handling with cache fallback
      let deficitMap: Map<string, string> | null = null;
      let deficitSource: 'fresh' | 'cache' | 'none' = 'none';

      if (deficitResult.status === 'fulfilled' && deficitResult.value.size > 0) {
        // Fresh deficit data - update cache
        deficitMap = deficitResult.value;
        deficitCache = { data: deficitMap, fetchedAt: Date.now() };
        deficitSource = 'fresh';
        logger.info(`📊 Deficit data (fresh): ${deficitMap.size} reserves`);
      } else {
        // Fresh fetch failed - check cache
        const cacheAge = deficitCache ? Date.now() - deficitCache.fetchedAt : Infinity;
        if (deficitCache && cacheAge < BACKEND_CACHE_TTL_MS.deficitCacheTtl) {
          deficitMap = deficitCache.data;
          deficitSource = 'cache';
          logger.info(`📊 Deficit data (cache, ${Math.round(cacheAge / 1000)}s old): ${deficitMap.size} reserves`);
        } else {
          logger.warn(`⚠️ Deficit unavailable: fresh fetch failed, cache ${deficitCache ? 'expired' : 'empty'}`);
        }
      }

      // Merge deficit into payload (write-time merge)
      if (deficitMap && deficitMap.size > 0) {
        for (const reserve of payload.data) {
          const key = `${reserve.chainId}:${reserve.tokenAddress.toLowerCase()}`;
          const deficit = deficitMap.get(key);
          if (deficit !== undefined) {
            (reserve as any).deficit = deficit;
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
        `✅ Unified refresh complete: ${payload.data.length} reserves in ${elapsed}ms (deficit: ${deficitSource})`
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
  ageMs: number | null;
} {
  if (!snapshot) {
    logger.warn('Markets snapshot not yet populated; returning null');
    return {
      payload: null,
      staleTimeMs: BACKEND_CACHE_TTL_MS.marketsDataStaleThreshold,
      ageMs: null,
    };
  }

  return {
    payload: snapshot.payload,
    staleTimeMs: BACKEND_CACHE_TTL_MS.marketsDataStaleThreshold,
    ageMs: Date.now() - snapshot.fetchedAt,
  };
}

/**
 * Warmup function for startup.
 * Ensures markets data is available before server accepts requests.
 */
export async function warmMarketsCache(): Promise<void> {
  await refreshMarketsSnapshot();
}
