import { FORECAST_SOFT_TTL_MS, getMerklForecastState } from '../services/merklForecastService.js';
import { getMarketsSnapshot, type RuntimeReserveData } from '../services/marketsService.js';
import { logger } from '../logger.js';
import { MERKL_TTL } from '../cacheTtl.js';
import {
  getForecastFieldRule,
  shouldIncludeForecastItem,
  type CampaignForecastType,
} from '../lib/merklApiContract.js';

const FORECAST_SNAPSHOT_HARD_TTL_MS = MERKL_TTL.forecastSnapshotHardTtlMs;

// Only metrics-dependent fields (require Merkl metrics API / dailyRewardsRecords).
// Opportunity-only fields (campaignType, totalBudget, aprCap, latestTvl, plannedDaily)
// are served from the markets endpoint breakdowns for 1-min freshness.
// DUTCH_AUCTION omits requiredDaily (always === plannedDaily; frontend falls back).
export const toForecastResponseItem = (
  state: Awaited<ReturnType<typeof getMerklForecastState>>,
) => {
  const type = state.campaignType as CampaignForecastType;
  if (!shouldIncludeForecastItem(type)) return null;

  const rule = getForecastFieldRule(type);
  const item: { campaignId: string; requiredDaily?: number; distributedSoFar: number; endTimestamp: number } = {
    campaignId: state.campaignId,
    ...(rule.includeRequiredDaily && { requiredDaily: state.requiredDaily }),
    distributedSoFar: state.distributedSoFar,
    endTimestamp: state.endTimestamp,
  };
  return item;
};

export type ForecastResponseItem = { campaignId: string; requiredDaily?: number; distributedSoFar: number; endTimestamp: number };

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
      const breakdowns = (group as { breakdowns?: Array<{ campaignId?: string }> }).breakdowns ?? [];
      for (const breakdown of breakdowns) {
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
    return ageMs <= FORECAST_SNAPSHOT_HARD_TTL_MS;
  };

  const marketsSnapshot = getMarketsSnapshot();
  if (!marketsSnapshot) {
    if (canUsePrevious()) {
      logger.warn('Using previous forecast snapshot fallback because markets snapshot is unavailable');
      return previous!.snapshot;
    }
    throw new Error('Forecast snapshot not ready: markets snapshot is unavailable');
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
    throw new Error('Forecast snapshot not ready: no campaign IDs available');
  }

  const results = await Promise.allSettled(campaignIds.map((id) => getMerklForecastState(id)));
  const items: ForecastResponseItem[] = [];
  const errors: ForecastSnapshot['errors'] = [];

  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      const item = toForecastResponseItem(result.value);
      if (item) items.push(item);
    } else {
      errors.push({
        campaignId: campaignIds[i],
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });

  const snapshot: ForecastSnapshot = { items, errors, staleTimeMs: FORECAST_SOFT_TTL_MS };

  if (items.length === 0 && canUsePrevious() && previous!.snapshot.items.length > 0) {
    logger.warn('Forecast refresh produced empty items; keeping previous forecast snapshot fallback');
    snapshotCache = {
      snapshot: previous!.snapshot,
      generatedAt: previous!.generatedAt,
    };
    return previous!.snapshot;
  }

  if (items.length === 0) {
    throw new Error('Forecast snapshot not ready: refresh produced no items');
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
  throw new Error('Forecast snapshot not ready: cache not yet populated');
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
