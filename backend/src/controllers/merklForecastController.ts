import type { Request, Response } from 'express';
import { getMerklForecastState } from '../services/merklForecastService.js';
import { dataService } from '../services/dataService.js';
import type { MarketWithSpread } from '../types/index.js';

const toResponseItem = (state: Awaited<ReturnType<typeof getMerklForecastState>>) => ({
  campaignId: state.campaignId,
  totalBudget: state.totalBudget,
  desiredDaily: state.desiredDaily,
  remainingBudget: state.remainingBudget,
  remainingDays: state.remainingDays,
  maxAPR: state.maxAPR,
  computedUntil: state.computedUntil,
  asOf: state.asOf,
  distributedSoFar: state.distributedSoFar,
  latestTvl: state.latestTvl,
  startTimestamp: state.startTimestamp,
  endTimestamp: state.endTimestamp,
  expectedByNow: state.expectedByNow,
});

const inferErrorStatus = (error: unknown): number => {
  const message = error instanceof Error ? error.message : String(error);
  if (/not MAX_APR capped/i.test(message)) return 422;
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

export const getCampaignForecastState = async (req: Request, res: Response): Promise<void> => {
  const campaignId = req.params.campaignId;

  if (!campaignId) {
    res.status(400).json({
      error: 'Bad request',
      message: 'campaignId is required',
    });
    return;
  }

  try {
    const state = await getMerklForecastState(campaignId);
    res.json(toResponseItem(state));
  } catch (error) {
    res.status(inferErrorStatus(error)).json({
      error: 'Unprocessable campaign',
      message: error instanceof Error ? error.message : String(error),
    });
  }
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
  });
};
