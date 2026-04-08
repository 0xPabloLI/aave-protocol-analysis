import { FORECAST_CACHE_TTL_MS, getMerklForecastState } from '../services/merklForecastService.js';
import { getMarketsSnapshot, type RuntimeReserveData } from '../services/marketsService.js';
import { logger } from '../logger.js';

const FORECAST_SNAPSHOT_FALLBACK_MAX_STALE_MS = (() => {
  const raw = process.env.MERKL_FORECAST_SNAPSHOT_FALLBACK_MAX_STALE_MS;
  const fallback = Math.max(FORECAST_CACHE_TTL_MS * 3, 30 * 60 * 1000);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
})();

// Only metrics-dependent fields (require Merkl metrics API / dailyRewardsRecords).
// Opportunity-only fields (campaignType, totalBudget, aprCap, latestTvl, plannedDaily)
// are served from the markets endpoint breakdowns for 1-min freshness.
export const toForecastResponseItem = (state: Awaited<ReturnType<typeof getMerklForecastState>>) => ({
  campaignId: state.campaignId,
  requiredDaily: state.requiredDaily,
  distributedSoFar: state.distributedSoFar,
  endTimestamp: state.endTimestamp,
});

export type ForecastResponseItem = ReturnType<typeof toForecastResponseItem>;

export interface ForecastSnapshot {
  items: ForecastResponseItem[];
  errors: Array<{ campaignId: string; message: string }>;
  staleTimeMs: number;
}

/** In-memory/cron snapshot reserves (`RuntimeReserveData`); yield fields are ratios, not GET /api/markets percents. */
const collectCampaignIdsFromMarkets = (markets: RuntimeReserveData[]): string[] => {
  const ids = new Set<string>();
  for (const market of markets) {
    for (const group of [...(market.merklSupplys ?? []), ...(market.merklBorrows ?? []), ...(market.merklHolds ?? [])]) {
      for (const breakdown of group.breakdowns ?? []) {
        const id = String(breakdown.campaignId || '').trim();
        if (id) ids.add(id);
      }
    }
  }
  return Array.from(ids);
};

// Global snapshot cache (cron-write, API-read-only pattern).
interface SnapshotCacheEntry {
  snapshot: ForecastSnapshot;
  generatedAt: number;
}
let snapshotCache: SnapshotCacheEntry | null = null;

/**
 * Fetch fresh forecast data from Merkl API and update the global snapshot cache.
 * Called by cron scheduler only.
 */
export const refreshForecastSnapshotCache = async (): Promise<ForecastSnapshot> => {
  const previous = snapshotCache;
  const canUsePrevious = (): boolean => {
    if (!previous) return false;
    const ageMs = Math.max(0, Date.now() - previous.generatedAt);
    return ageMs <= FORECAST_SNAPSHOT_FALLBACK_MAX_STALE_MS;
  };

  const marketsSnapshot = getMarketsSnapshot();
  if (!marketsSnapshot) {
    logger.warn('Markets snapshot not available for forecast refresh; returning empty snapshot');
    if (canUsePrevious()) {
      logger.warn('Using previous forecast snapshot fallback because markets snapshot is unavailable');
      return previous!.snapshot;
    }
    return { items: [], errors: [], staleTimeMs: FORECAST_CACHE_TTL_MS };
  }
  const campaignIds = [...new Set(collectCampaignIdsFromMarkets(marketsSnapshot.payload.data))];
  if (campaignIds.length === 0) {
    if (canUsePrevious() && previous!.snapshot.items.length > 0) {
      logger.warn('No campaign IDs found; keeping previous forecast snapshot fallback');
      snapshotCache = {
        snapshot: previous!.snapshot,
        generatedAt: previous!.generatedAt,
      };
      return previous!.snapshot;
    }
    const emptySnapshot: ForecastSnapshot = { items: [], errors: [], staleTimeMs: FORECAST_CACHE_TTL_MS };
    snapshotCache = { snapshot: emptySnapshot, generatedAt: Date.now() };
    return emptySnapshot;
  }

  const results = await Promise.allSettled(campaignIds.map((id) => getMerklForecastState(id)));
  const items: ForecastResponseItem[] = [];
  const errors: ForecastSnapshot['errors'] = [];

  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      items.push(toForecastResponseItem(result.value));
    } else {
      errors.push({
        campaignId: campaignIds[i],
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });

  const snapshot: ForecastSnapshot = { items, errors, staleTimeMs: FORECAST_CACHE_TTL_MS };

  if (items.length === 0 && canUsePrevious() && previous!.snapshot.items.length > 0) {
    logger.warn('Forecast refresh produced empty items; keeping previous forecast snapshot fallback');
    snapshotCache = {
      snapshot: previous!.snapshot,
      generatedAt: previous!.generatedAt,
    };
    return previous!.snapshot;
  }

  snapshotCache = { snapshot, generatedAt: Date.now() };
  return snapshot;
};

/**
 * Get forecast snapshot from cache (API-read-only).
 * Returns cached snapshot if available, or empty snapshot with warning if cache not yet populated.
 */
export const getForecastSnapshot = async (): Promise<ForecastSnapshot> => {
  if (snapshotCache) {
    return snapshotCache.snapshot;
  }
  // Cache not yet populated (server just started, cron hasn't run yet).
  // Return empty snapshot instead of triggering fetch.
  logger.warn('Forecast snapshot cache not yet populated; returning empty snapshot');
  return { items: [], errors: [], staleTimeMs: FORECAST_CACHE_TTL_MS };
};

/**
 * Warm the forecast snapshot cache by fetching fresh data from Merkl API.
 * Called by cron scheduler and server startup.
 */
export async function warmCampaignForecastStatesCache(): Promise<{ requested: number; fulfilled: number; failed: number }> {
  const snapshot = await refreshForecastSnapshotCache();
  return {
    requested: snapshot.items.length + snapshot.errors.length,
    fulfilled: snapshot.items.length,
    failed: snapshot.errors.length,
  };
}
