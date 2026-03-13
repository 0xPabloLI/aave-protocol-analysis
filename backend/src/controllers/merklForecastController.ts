import type { Request, Response } from 'express';
import { FORECAST_CACHE_TTL_MS, getMerklForecastState } from '../services/merklForecastService.js';
import { dataService } from '../services/dataService.js';
import type { MarketWithSpread } from '../types/index.js';

export const toForecastResponseItem = (state: Awaited<ReturnType<typeof getMerklForecastState>>) => ({
  campaignId: state.campaignId,
  campaignType: state.campaignType,
  plannedDaily: state.plannedDaily,
  requiredDaily: state.requiredDaily,
  aprCap: state.aprCap,
  totalBudget: state.totalBudget,
  distributedSoFar: state.distributedSoFar,
  latestTvl: state.latestTvl,
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

export const getForecastSnapshot = async (): Promise<ForecastSnapshot> => {
  const campaignIds = [...new Set(collectCampaignIdsFromMarkets(await dataService.getData()))];
  if (campaignIds.length === 0) {
    return { items: [], errors: [], staleTimeMs: FORECAST_CACHE_TTL_MS };
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

  return { items, errors, staleTimeMs: FORECAST_CACHE_TTL_MS };
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

export async function warmCampaignForecastStatesCache(): Promise<{ requested: number; fulfilled: number; failed: number }> {
  const snapshot = await getForecastSnapshot();
  return {
    requested: snapshot.items.length + snapshot.errors.length,
    fulfilled: snapshot.items.length,
    failed: snapshot.errors.length,
  };
}
