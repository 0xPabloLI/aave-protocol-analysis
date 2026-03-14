/**
 * Markets Service - Cron-write/API-read-only pattern
 *
 * This service internalizes the data fetcher logic:
 * - Cron (every 1 minute) calls refreshMarketsSnapshot() to fetch fresh data
 * - API requests only read from the in-memory snapshot, never trigger fetches
 * - Startup warmup ensures data is available before server accepts requests
 */

import { fetchMarketsPayload, type MarketsPayload, type RuntimeReserveData } from '../../../dist/index.js';
import { BACKEND_CACHE_TTL_MS } from '../cacheTtl.js';
import { logger } from '../logger.js';

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
 */
export async function refreshMarketsSnapshot(): Promise<MarketsSnapshot> {
  // If refresh is already in progress, wait for it
  if (refreshInProgress) {
    return refreshInProgress;
  }

  refreshInProgress = (async () => {
    try {
      const startTime = Date.now();
      logger.info('🔄 Starting markets data refresh...');

      const payload = await fetchMarketsPayload();

      const newSnapshot: MarketsSnapshot = {
        payload,
        fetchedAt: Date.now(),
      };

      snapshot = newSnapshot;

      const elapsed = Date.now() - startTime;
      logger.info(
        `✅ Markets refresh complete: ${payload.data.length} reserves in ${elapsed}ms`
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
