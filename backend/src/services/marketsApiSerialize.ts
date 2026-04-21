/**
 * GET /api/markets 响应层：将内存快照中的收益率字段从比例值转为百分值（方案 A）。
 * 内存/cron 路径仍使用比例值，与 on-chain 回退计算一致。
 */
import type { MarketWithSpread } from '../types/index.js';
import type { RuntimeReserveData } from './marketsService.js';
import {
  getBreakdownFieldRule,
  type CampaignForecastType,
} from '../lib/merklApiContract.js';

function scaleMeritEntry<T extends { apr: number; selfApr?: number }>(e: T): T {
  return {
    ...e,
    apr: e.apr * 100,
    ...(e.selfApr !== undefined ? { selfApr: e.selfApr * 100 } : {}),
  };
}

function scaleMerklBreakdown<
  T extends {
    campaignApr: number;
    aprCap?: number | null;
    campaignType?: CampaignForecastType;
    plannedDaily?: number;
    totalBudget?: number;
  },
>(b: T): T {
  const next = { ...b, campaignApr: b.campaignApr * 100 } as T;
  if (Object.prototype.hasOwnProperty.call(b, 'aprCap')) {
    const cap = b.aprCap;
    (next as { aprCap?: number | null }).aprCap =
      cap === null || cap === undefined ? cap : cap * 100;
  }
  // 应用 API contract 字段规则
  if (b.campaignType) {
    const rule = getBreakdownFieldRule(b.campaignType);
    for (const field of rule.omit) {
      delete (next as Record<string, unknown>)[field];
    }
  }
  return next;
}

function scaleBrevisBreakdown<T extends { campaignApr: number }>(b: T): T {
  return { ...b, campaignApr: b.campaignApr * 100 };
}

function scaleGroupedCampaigns<
  TBreakdown extends { campaignApr: number },
  TGroup extends { breakdowns: TBreakdown[] },
>(groups: TGroup[] | undefined, scaleBreakdown: (breakdown: TBreakdown) => TBreakdown): TGroup[] | undefined {
  if (!groups?.length) return undefined;
  return groups.map((group) => ({
    ...group,
    breakdowns: group.breakdowns.map(scaleBreakdown),
  }));
}

export function serializeReserveForApi(reserve: RuntimeReserveData): MarketWithSpread {
  const out: MarketWithSpread = {
    reserveId: reserve.reserveId,
    marketName: reserve.marketName,
    chainName: reserve.chainName,
    chainId: reserve.chainId,
    tokenName: reserve.tokenName,
    tokenSymbol: reserve.tokenSymbol,
    tokenAddress: reserve.tokenAddress,
    ...(reserve.aaveProReserveId ? { aaveProReserveId: reserve.aaveProReserveId } : {}),
    ...(reserve.tokenPrice !== undefined ? { tokenPrice: reserve.tokenPrice } : {}),
    ...(reserve.reserveSizeUsd !== undefined ? { reserveSizeUsd: reserve.reserveSizeUsd } : {}),
    ...(reserve.utilizationPct !== undefined ? { utilizationPct: reserve.utilizationPct } : {}),
    ...(reserve.aTokenAddress !== undefined ? { aTokenAddress: reserve.aTokenAddress } : {}),
    ...(reserve.vTokenAddress !== undefined ? { vTokenAddress: reserve.vTokenAddress } : {}),
    ...(reserve.supplyApy !== undefined ? { supplyApy: reserve.supplyApy * 100 } : {}),
    ...(reserve.supplyDisabled ? { supplyDisabled: true } : {}),
    ...(reserve.supplyCapUsd !== undefined ? { supplyCapUsd: reserve.supplyCapUsd } : {}),
    ...(reserve.borrowApy !== undefined ? { borrowApy: reserve.borrowApy * 100 } : {}),
    ...(reserve.borrowDisabled ? { borrowDisabled: true } : {}),
    ...(reserve.borrowCapUsd !== undefined ? { borrowCapUsd: reserve.borrowCapUsd } : {}),
    ...(reserve.decimals !== undefined ? { decimals: reserve.decimals } : {}),
    ...(reserve.availableLiquidity ? { availableLiquidity: reserve.availableLiquidity } : {}),
    ...(reserve.totalVariableDebt ? { totalVariableDebt: reserve.totalVariableDebt } : {}),
    ...(reserve.reserveFactor ? { reserveFactor: reserve.reserveFactor } : {}),
    ...(reserve.variableRateSlope1 ? { variableRateSlope1: reserve.variableRateSlope1 } : {}),
    ...(reserve.variableRateSlope2 ? { variableRateSlope2: reserve.variableRateSlope2 } : {}),
    ...(reserve.optimalUsageRate ? { optimalUsageRate: reserve.optimalUsageRate } : {}),
    ...(reserve.baseVariableBorrowRate !== undefined
      ? { baseVariableBorrowRate: reserve.baseVariableBorrowRate }
      : {}),
    ...(reserve.deficit !== undefined ? { deficit: reserve.deficit } : {}),
    ...(reserve.supplyIncentives?.length
      ? { supplyIncentives: reserve.supplyIncentives.map((x) => x * 100) }
      : {}),
    ...(reserve.borrowIncentives?.length
      ? { borrowIncentives: reserve.borrowIncentives.map((x) => x * 100) }
      : {}),
    ...(reserve.meritSupplys?.length
      ? { meritSupplys: reserve.meritSupplys.map(scaleMeritEntry) }
      : {}),
    ...(reserve.meritBorrows?.length
      ? { meritBorrows: reserve.meritBorrows.map(scaleMeritEntry) }
      : {}),
    ...(reserve.merklSupplys?.length
      ? { merklSupplys: scaleGroupedCampaigns(reserve.merklSupplys, scaleMerklBreakdown) }
      : {}),
    ...(reserve.merklBorrows?.length
      ? { merklBorrows: scaleGroupedCampaigns(reserve.merklBorrows, scaleMerklBreakdown) }
      : {}),
    ...(reserve.merklHolds?.length
      ? { merklHolds: scaleGroupedCampaigns(reserve.merklHolds, scaleMerklBreakdown) }
      : {}),
    ...(reserve.brevisSupplys?.length
      ? { brevisSupplys: scaleGroupedCampaigns(reserve.brevisSupplys, scaleBrevisBreakdown) }
      : {}),
    ...(reserve.brevisBorrows?.length
      ? { brevisBorrows: scaleGroupedCampaigns(reserve.brevisBorrows, scaleBrevisBreakdown) }
      : {}),
    // V4 Hub & Spoke addresses (only for V4 markets)
    ...(reserve.hubId ? { hubId: reserve.hubId } : {}),
    ...(reserve.hubName ? { hubName: reserve.hubName } : {}),
    ...(reserve.hubAddress ? { hubAddress: reserve.hubAddress } : {}),
    ...(reserve.spokeId ? { spokeId: reserve.spokeId } : {}),
    ...(reserve.spokeName ? { spokeName: reserve.spokeName } : {}),
    ...(reserve.spokeAddress ? { spokeAddress: reserve.spokeAddress } : {}),
  };
  return out;
}

export function serializeMarketsReservesForApi(reserves: RuntimeReserveData[]): MarketWithSpread[] {
  return reserves.map(serializeReserveForApi);
}
