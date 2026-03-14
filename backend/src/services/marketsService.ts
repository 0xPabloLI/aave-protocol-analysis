/**
 * Markets Service - Cron-write/API-read-only pattern
 *
 * This service internalizes the data fetcher logic:
 * - Cron (every 1 minute) calls refreshMarketsSnapshot() to fetch fresh data
 * - API requests only read from the in-memory snapshot, never trigger fetches
 * - Startup warmup ensures data is available before server accepts requests
 * 
 * Architecture (single fetchedAt):
 * - Parallel fetch: Aave API (markets) + RPC (on-chain fields: deficit, baseVariableBorrowRate)
 * - Merge on-chain data into markets at write time
 * - If RPC fails, uses cached on-chain data within TTL; otherwise fields absent
 */

import { fetchMarketsPayload, type MarketsPayload, type RuntimeReserveData } from '../../../dist/index.js';
import { BACKEND_CACHE_TTL_MS } from '../cacheTtl.js';
import { logger } from '../logger.js';
import { fetchAllOnchainData, type OnchainReserveData } from './onchainDataService.js';

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

// On-chain data cache - persists across refreshes for graceful degradation
interface OnchainCache {
  data: Map<string, OnchainReserveData>;
  fetchedAt: number;
}

// In-memory snapshot (cron-write, API-read-only)
let snapshot: MarketsSnapshot | null = null;

// On-chain data cache - updated on successful fetch, used when fresh fetch fails
let onchainCache: OnchainCache | null = null;

// Refresh lock to prevent concurrent refreshes
let refreshInProgress: Promise<MarketsSnapshot> | null = null;

/**
 * Refresh the markets snapshot.
 * Called by cron and startup warmup.
 * Uses a lock to prevent concurrent refreshes.
 * 
 * Fetches markets from Aave API and on-chain data (deficit, baseVariableBorrowRate) from RPC in parallel.
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
      logger.info('🔄 Starting unified markets + on-chain refresh...');

      // Parallel fetch: markets from API, on-chain data from RPC
      // Both have independent timeouts for graceful degradation
      const [marketsResult, onchainResult] = await Promise.allSettled([
        withTimeout(fetchMarketsPayload(), MARKETS_FETCH_TIMEOUT_MS, 'Markets fetch timeout'),
        fetchAllOnchainData(), // Has internal 15s timeout per chain
      ]);

      // Markets is required - if it fails, don't update snapshot
      if (marketsResult.status === 'rejected') {
        logger.error(`Markets fetch failed: ${marketsResult.reason}`);
        throw marketsResult.reason;
      }

      const payload = marketsResult.value;
      
      // On-chain data handling with cache fallback
      let onchainMap: Map<string, OnchainReserveData> | null = null;
      let onchainSource: 'fresh' | 'cache' | 'none' = 'none';

      if (onchainResult.status === 'fulfilled' && onchainResult.value.size > 0) {
        // Fresh on-chain data - update cache
        onchainMap = onchainResult.value;
        onchainCache = { data: onchainMap, fetchedAt: Date.now() };
        onchainSource = 'fresh';
        logger.info(`📊 On-chain data (fresh): ${onchainMap.size} reserves`);
      } else {
        // Fresh fetch failed - check cache
        const cacheAge = onchainCache ? Date.now() - onchainCache.fetchedAt : Infinity;
        if (onchainCache && cacheAge < BACKEND_CACHE_TTL_MS.onchainCacheTtl) {
          onchainMap = onchainCache.data;
          onchainSource = 'cache';
          logger.info(`📊 On-chain data (cache, ${Math.round(cacheAge / 1000)}s old): ${onchainMap.size} reserves`);
        } else {
          logger.warn(`⚠️ On-chain data unavailable: fresh fetch failed, cache ${onchainCache ? 'expired' : 'empty'}`);
        }
      }

      // Merge on-chain data into payload (write-time merge)
      if (onchainMap && onchainMap.size > 0) {
        for (const reserve of payload.data) {
          const key = `${reserve.chainId}:${reserve.tokenAddress.toLowerCase()}`;
          const onchainData = onchainMap.get(key);
          if (onchainData) {
            // Only add fields if they have values (don't add undefined)
            if (onchainData.deficit !== undefined) {
              (reserve as any).deficit = onchainData.deficit;
            }
            if (onchainData.baseVariableBorrowRate !== undefined) {
              (reserve as any).baseVariableBorrowRate = onchainData.baseVariableBorrowRate;
            }
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
        `✅ Unified refresh complete: ${payload.data.length} reserves in ${elapsed}ms (on-chain: ${onchainSource})`
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
