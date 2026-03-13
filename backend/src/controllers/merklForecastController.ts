import type { Request, Response } from 'express';
import { FORECAST_CACHE_TTL_MS, getMerklForecastState } from '../services/merklForecastService.js';
import { dataService } from '../services/dataService.js';
import type { MarketWithSpread } from '../types/index.js';

const toResponseItem = (state: Awaited<ReturnType<typeof getMerklForecastState>>) => ({
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

  const collectFromBreakdowns = (
    groups:
      | MarketWithSpread['merklSupplys']
      | MarketWithSpread['merklBorrows']
      | MarketWithSpread['merklHolds']
      | undefined
  ) => {
    if (!groups) return;
    groups.forEach((group) => {
      group.breakdowns?.forEach((breakdown) => {
        const id = String(breakdown.campaignId || '').trim();
        if (id) ids.add(id);
      });
    });
  };

  markets.forEach((market) => {
    collectFromBreakdowns(market.merklSupplys);
    collectFromBreakdowns(market.merklBorrows);
    collectFromBreakdowns(market.merklHolds);
  });

  return Array.from(ids);
};

export const getCampaignForecastStates = async (req: Request, res: Response): Promise<void> => {
  const idsRaw = typeof req.query.ids === 'string' ? req.query.ids : '';
  const idsFromQuery = idsRaw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  if (idsFromQuery.length > 100) {
    res.status(400).json({
      error: 'Bad request',
      message: 'Too many campaign ids. Maximum allowed is 100 per request.',
    });
    return;
  }

  const campaignIds =
    idsFromQuery.length > 0
      ? idsFromQuery
      : collectCampaignIdsFromMarkets(await dataService.getData());

  const dedupedCampaignIds = Array.from(new Set(campaignIds));
  const results = await Promise.allSettled(dedupedCampaignIds.map((campaignId) => getMerklForecastState(campaignId)));

  const items: Array<ReturnType<typeof toResponseItem>> = [];
  const errors: Array<{ campaignId: string; status: number; message: string }> = [];

  results.forEach((result, index) => {
    const campaignId = dedupedCampaignIds[index];
    if (result.status === 'fulfilled') {
      items.push(toResponseItem(result.value));
      return;
    }
    const status = inferErrorStatus(result.reason);
    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
    errors.push({ campaignId, status, message });
  });

  res.json({
    requested: dedupedCampaignIds.length,
    items,
    errors,
    staleTimeMs: FORECAST_CACHE_TTL_MS,
  });
};

export async function warmCampaignForecastStatesCache(): Promise<{
  requested: number;
  fulfilled: number;
  failed: number;
}> {
  const campaignIds = collectCampaignIdsFromMarkets(await dataService.getData());
  const dedupedCampaignIds = Array.from(new Set(campaignIds));
  if (dedupedCampaignIds.length === 0) {
    return { requested: 0, fulfilled: 0, failed: 0 };
  }

  const results = await Promise.allSettled(
    dedupedCampaignIds.map((campaignId) => getMerklForecastState(campaignId))
  );
  const fulfilled = results.filter((result) => result.status === 'fulfilled').length;
  const failed = results.length - fulfilled;
  return { requested: dedupedCampaignIds.length, fulfilled, failed };
}
