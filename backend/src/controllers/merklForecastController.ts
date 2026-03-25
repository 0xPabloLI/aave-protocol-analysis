import type { Request, Response } from 'express';
import { FORECAST_CACHE_TTL_MS, getMerklForecastState } from '../services/merklForecastService.js';
import { getMarketsSnapshot } from '../services/marketsService.js';
import { logger } from '../logger.js';
import type { MarketWithSpread } from '../types/index.js';

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

const inferErrorStatus = (error: unknown): number => {
  const message = error instanceof Error ? error.message : String(error);
  if (/Metrics unavailable/i.test(message)) return 409;
  if (/unsupported distribution type/i.test(message)) return 422;
  if (/Missing APR cap/i.test(message)) return 422;
  if (/Missing .*campaign/i.test(message) || /Missing .*timestamp/i.test(message)) return 422;
  if (/Merkl API 404/i.test(message)) return 404;
  return 500;
};

const collectCampaignIdsFromMarkets = (markets: MarketWithSpread[]): string[] => {
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
  const marketsSnapshot = getMarketsSnapshot();
  if (!marketsSnapshot) {
    logger.warn('Markets snapshot not available for forecast refresh; returning empty snapshot');
    return { items: [], errors: [], staleTimeMs: FORECAST_CACHE_TTL_MS };
  }
  const campaignIds = [...new Set(collectCampaignIdsFromMarkets(marketsSnapshot.payload.data))];
  if (campaignIds.length === 0) {
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

export const getCampaignForecastStates = async (req: Request, res: Response): Promise<void> => {
  const idsRaw = typeof req.query.ids === 'string' ? req.query.ids : '';
  const idsFromQuery = idsRaw.split(',').map((s) => s.trim()).filter(Boolean);

  if (idsFromQuery.length > 100) {
    res.status(400).json({ error: 'Bad request', message: 'Too many campaign ids. Maximum allowed is 100.' });
    return;
  }

  if (idsFromQuery.length === 0) {
    const snapshot = await getForecastSnapshot();
    res.json({ requested: snapshot.items.length + snapshot.errors.length, ...snapshot });
    return;
  }

  const campaignIds = [...new Set(idsFromQuery)];
  const results = await Promise.allSettled(campaignIds.map((id) => getMerklForecastState(id)));
  const items: ForecastResponseItem[] = [];
  const errors: Array<{ campaignId: string; status: number; message: string }> = [];

  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      items.push(toForecastResponseItem(result.value));
    } else {
      errors.push({
        campaignId: campaignIds[i],
        status: inferErrorStatus(result.reason),
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });

  res.json({ requested: campaignIds.length, items, errors, staleTimeMs: FORECAST_CACHE_TTL_MS });
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
