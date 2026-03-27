/**
 * GET /api/markets 响应层：将内存快照中的收益率字段从比例值转为百分值（方案 A）。
 * 内存/cron 路径仍使用比例值，与 on-chain 回退计算一致。
 */
import type { MarketWithSpread } from '../types/index.js';
import type { RuntimeReserveData } from './marketsService.js';

function scaleMeritEntry<T extends { apr: number; selfApr?: number }>(e: T): T {
  return {
    ...e,
    apr: e.apr * 100,
    ...(e.selfApr !== undefined ? { selfApr: e.selfApr * 100 } : {}),
  };
}

function scaleMerklBreakdown<
  T extends { campaignApr: number; aprCap?: number | null },
>(b: T): T {
  const next = { ...b, campaignApr: b.campaignApr * 100 } as T;
  if (Object.prototype.hasOwnProperty.call(b, 'aprCap')) {
    const cap = b.aprCap;
    (next as { aprCap?: number | null }).aprCap =
      cap === null || cap === undefined ? cap : cap * 100;
  }
  return next;
}

function scaleBrevisCampaign<T extends { campaignApr: number }>(c: T): T {
  return { ...c, campaignApr: c.campaignApr * 100 };
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
      ? {
          merklSupplys: reserve.merklSupplys.map((g) => ({
            ...g,
            breakdowns: g.breakdowns.map(scaleMerklBreakdown),
          })),
        }
      : {}),
    ...(reserve.merklBorrows?.length
      ? {
          merklBorrows: reserve.merklBorrows.map((g) => ({
            ...g,
            breakdowns: g.breakdowns.map(scaleMerklBreakdown),
          })),
        }
      : {}),
    ...(reserve.merklHolds?.length
      ? {
          merklHolds: reserve.merklHolds.map((g) => ({
            ...g,
            breakdowns: g.breakdowns.map(scaleMerklBreakdown),
          })),
        }
      : {}),
    ...(reserve.brevisSupplys?.length
      ? { brevisSupplys: reserve.brevisSupplys.map(scaleBrevisCampaign) }
      : {}),
    ...(reserve.brevisBorrows?.length
      ? { brevisBorrows: reserve.brevisBorrows.map(scaleBrevisCampaign) }
      : {}),
  };
  return out;
}

export function serializeMarketsReservesForApi(reserves: RuntimeReserveData[]): MarketWithSpread[] {
  return reserves.map(serializeReserveForApi);
}
