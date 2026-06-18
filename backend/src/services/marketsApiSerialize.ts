/**
 * GET /api/markets 响应层：将内存快照中的收益率字段从比例值转为百分值（方案 A）。
 * 内存/cron 路径仍使用比例值，与 on-chain 回退计算一致。
 */
import { createHash } from 'node:crypto';
import type { MarketWithSpread } from '../types/index.js';
import type { RuntimeReserveData } from '@internal/aave-shared-contracts';
import {
  getBreakdownFieldRule,
  type CampaignForecastType,
} from '../lib/merklApiContract.js';
import { computeTargetTotalAprIncentiveApr } from '../lib/aprApyConversion.js';

export function roundTo6(n: number): number {
  return Number(n.toFixed(6));
}

function scaleMeritEntry<T extends { apr: number; selfApr?: number }>(e: T): T {
  return {
    ...e,
    apr: roundTo6(e.apr * 100),
    ...(e.selfApr !== undefined ? { selfApr: roundTo6(e.selfApr * 100) } : {}),
  };
}

function scaleMeritCampaignBreakdown<T extends { campaignApr: number; positionCap?: number; aprCap?: number }>(b: T): T {
  const next = { ...b, campaignApr: roundTo6(b.campaignApr * 100) } as T;
  if (Object.prototype.hasOwnProperty.call(b, 'positionCap') && b.positionCap !== undefined) {
    (next as { positionCap?: number }).positionCap = roundTo6(b.positionCap * 100);
  }
  if (Object.prototype.hasOwnProperty.call(b, 'aprCap') && b.aprCap !== undefined) {
    (next as { aprCap?: number }).aprCap = roundTo6(b.aprCap * 100);
  }
  return next;
}

function scaleMerklBreakdown<
  T extends {
    campaignApr: number;
    aprCap?: number | null;
    campaignType?: CampaignForecastType;
    plannedDaily?: number;
    totalBudget?: number;
    budgetBoundMode?: string;
  },
>(b: T, nativeApy?: number, side?: 'supply' | 'borrow'): T {
  const isTargetTotal = b.campaignType === 'TARGET_TOTAL_APR';
  let campaignAprScaled: number;
  if (isTargetTotal && nativeApy !== undefined && side !== undefined && b.aprCap != null) {
    const aprCapPercent = roundTo6(b.aprCap * 100);
    const incentiveAprPercent = computeTargetTotalAprIncentiveApr(aprCapPercent, roundTo6(nativeApy * 100), side);
    campaignAprScaled = incentiveAprPercent;
  } else {
    campaignAprScaled = roundTo6(b.campaignApr * 100);
  }
  const next = { ...b, campaignApr: campaignAprScaled } as T;
  if (Object.prototype.hasOwnProperty.call(b, 'aprCap')) {
    const cap = b.aprCap;
    (next as { aprCap?: number | null }).aprCap =
      cap === null || cap === undefined ? cap : roundTo6(cap * 100);
  }
  if (b.campaignType) {
    const rule = getBreakdownFieldRule(b.campaignType, b.budgetBoundMode);
    for (const field of rule.omit) {
      delete (next as Record<string, unknown>)[field];
    }
  }
  return next;
}

function scaleBrevisBreakdown<T extends { campaignApr: number; aprCap?: number }>(b: T): T {
  const next = { ...b, campaignApr: roundTo6(b.campaignApr * 100) } as T;
  if (Object.prototype.hasOwnProperty.call(b, 'aprCap')) {
    const cap = b.aprCap;
    (next as { aprCap?: number }).aprCap = cap === undefined ? cap : roundTo6(cap * 100);
  }
  return next;
}

function scaleGroupedCampaigns<
  TBreakdown extends { campaignApr: number },
  TGroup extends { breakdowns: TBreakdown[] },
>(groups: TGroup[] | undefined, scaleBreakdown: (breakdown: TBreakdown) => TBreakdown): TGroup[] | undefined {
  if (!groups?.length) return undefined;
  return groups.map((group) => ({
    ...group,
    breakdowns: group.breakdowns.map((bd) => scaleBreakdown(bd)),
  }));
}

function scaleGroupedCampaignsWithContext<
  TBreakdown extends { campaignApr: number },
  TGroup extends { breakdowns: TBreakdown[] },
>(groups: TGroup[] | undefined, nativeApy: number, side: 'supply' | 'borrow'): TGroup[] | undefined {
  if (!groups?.length) return undefined;
  return groups.map((group) => ({
    ...group,
    breakdowns: group.breakdowns.map((bd) => scaleMerklBreakdown(bd, nativeApy, side)),
  }));
}

const PASSTHROUGH_FIELDS: readonly (keyof RuntimeReserveData)[] = [
  'tokenPrice', 'utilizationPct', 'aTokenAddress', 'vTokenAddress',
  'liquidity', 'borrowed', 'supplied', 'supplyCap', 'borrowCap', 'deficit',
  'hubId', 'hubName', 'spokeId', 'spokeName',
] as const;

function pickDefined(reserve: RuntimeReserveData, fields: readonly (keyof RuntimeReserveData)[]): Partial<MarketWithSpread> {
  const out: Partial<MarketWithSpread> = {};
  for (const f of fields) {
    const v = reserve[f];
    if (v !== undefined) (out as Record<string, unknown>)[f] = v;
  }
  return out;
}

export function serializeReserveForApi(reserve: RuntimeReserveData): MarketWithSpread {
  return {
    reserveId: reserve.reserveId,
    marketName: reserve.marketName,
    chainName: reserve.chainName,
    chainId: reserve.chainId,
    tokenName: reserve.tokenName,
    tokenSymbol: reserve.tokenSymbol,
    tokenAddress: reserve.tokenAddress,
    ...pickDefined(reserve, PASSTHROUGH_FIELDS),
    ...(reserve.aaveProReserveId ? { aaveProReserveId: reserve.aaveProReserveId } : {}),
    ...(reserve.supplyDisabled ? { supplyDisabled: true } : {}),
    ...(reserve.isFrozen ? { isFrozen: true } : {}),
    ...(reserve.isPaused ? { isPaused: true } : {}),
    ...(reserve.isActive === false ? { isActive: false as const } : {}),
    ...(reserve.borrowDisabled ? { borrowDisabled: true } : {}),
    ...(reserve.decimals !== undefined && reserve.decimals !== 18 ? { decimals: reserve.decimals } : {}),
    ...(reserve.supplyApy !== undefined ? { supplyApy: roundTo6(reserve.supplyApy * 100) } : {}),
    ...(reserve.borrowApy !== undefined ? { borrowApy: roundTo6(reserve.borrowApy * 100) } : {}),
    ...(reserve.protocolFee ? { protocolFee: roundTo6(reserve.protocolFee) } : {}),
    ...(reserve.slopeBelowOptimal !== undefined ? { slopeBelowOptimal: roundTo6(reserve.slopeBelowOptimal) } : {}),
    ...(reserve.slopeAboveOptimal !== undefined ? { slopeAboveOptimal: roundTo6(reserve.slopeAboveOptimal) } : {}),
    ...(reserve.optimalUtilization !== undefined ? { optimalUtilization: roundTo6(reserve.optimalUtilization) } : {}),
    ...(reserve.baseBorrowRate !== undefined ? { baseBorrowRate: roundTo6(reserve.baseBorrowRate) } : {}),
    ...(reserve.collateralRisk !== undefined ? { collateralRisk: roundTo6(reserve.collateralRisk) } : {}),
    ...(reserve.meritSupplys?.length ? { meritSupplys: reserve.meritSupplys.map((e) => scaleMeritEntry(e)) } : {}),
    ...(reserve.meritBorrows?.length ? { meritBorrows: reserve.meritBorrows.map((e) => scaleMeritEntry(e)) } : {}),
    ...(reserve.meritCampaignSupplys?.length ? { meritCampaignSupplys: scaleGroupedCampaigns(reserve.meritCampaignSupplys, scaleMeritCampaignBreakdown) } : {}),
    ...(reserve.meritCampaignBorrows?.length ? { meritCampaignBorrows: scaleGroupedCampaigns(reserve.meritCampaignBorrows, scaleMeritCampaignBreakdown) } : {}),
    ...(reserve.merklSupplys?.length && reserve.supplyApy !== undefined
      ? { merklSupplys: scaleGroupedCampaignsWithContext(reserve.merklSupplys, reserve.supplyApy, 'supply') }
      : reserve.merklSupplys?.length ? { merklSupplys: scaleGroupedCampaigns(reserve.merklSupplys, (bd) => scaleMerklBreakdown(bd)) } : {}),
    ...(reserve.merklBorrows?.length && reserve.borrowApy !== undefined
      ? { merklBorrows: scaleGroupedCampaignsWithContext(reserve.merklBorrows, reserve.borrowApy, 'borrow') }
      : reserve.merklBorrows?.length ? { merklBorrows: scaleGroupedCampaigns(reserve.merklBorrows, (bd) => scaleMerklBreakdown(bd)) } : {}),
    ...(reserve.merklHolds?.length ? { merklHolds: scaleGroupedCampaigns(reserve.merklHolds, (bd) => scaleMerklBreakdown(bd)) } : {}),
    ...(reserve.brevisSupplys?.length ? { brevisSupplys: scaleGroupedCampaigns(reserve.brevisSupplys, scaleBrevisBreakdown) } : {}),
    ...(reserve.brevisBorrows?.length ? { brevisBorrows: scaleGroupedCampaigns(reserve.brevisBorrows, scaleBrevisBreakdown) } : {}),
  };
}

export function serializeMarketsReservesForApi(reserves: RuntimeReserveData[]): MarketWithSpread[] {
  return reserves.map(serializeReserveForApi);
}

// ============================================================
// Schema fingerprint — deterministic hash of API response shape.
//
// When the output field set of serializeReserveForApi() changes,
// this fingerprint changes. Backend snapshot test fails if the
// fingerprint drifts, reminding the developer to bump CACHE_VERSION
// in aaveapy/src/lib/cache.ts.
//
// The fingerprint is also included in the API response so the
// frontend can detect stale cached data at runtime.
// ============================================================

let _cachedFingerprint: string | null = null;

/**
 * Compute a deterministic hash of the API response shape.
 * Serializes a canonical reserve (with all optional fields set)
 * through serializeReserveForApi(), then hashes the sorted set of
 * output field names.
 */
export function computeSchemaFingerprint(): string {
  if (_cachedFingerprint) return _cachedFingerprint;

  const canonical: RuntimeReserveData = {
    reserveId: '__fingerprint__',
    marketName: '__fingerprint__',
    chainName: '__fingerprint__',
    chainId: 1,
    tokenName: '__fingerprint__',
    tokenSymbol: '__fingerprint__',
    tokenAddress: '0x0000000000000000000000000000000000000001',
    aaveProReserveId: '__fingerprint__',
    tokenPrice: 1,
    utilizationPct: 1,
    aTokenAddress: '0x0000000000000000000000000000000000000001',
    vTokenAddress: '0x0000000000000000000000000000000000000001',
    supplyApy: 0.01,
    supplyDisabled: true,
    isFrozen: true,
    isPaused: true,
    isActive: false,
    borrowApy: 0.01,
    borrowDisabled: true,
    decimals: 6,
    liquidity: '1',
    borrowed: '1',
    supplied: '1',
    supplyCap: '1',
    borrowCap: '1',
    protocolFee: 10,
    slopeBelowOptimal: 1,
    slopeAboveOptimal: 1,
    optimalUtilization: 1,
    baseBorrowRate: 0.01,
    deficit: '1',
    meritSupplys: [{
      apr: 0.01, link: '__fingerprint__',
      startDate: '2025-01-01', endDate: '2025-01-01',
    }],
    meritBorrows: [{
      apr: 0.01, link: '__fingerprint__',
      startDate: '2025-01-01', endDate: '2025-01-01',
    }],
    meritCampaignSupplys: [{
      link: '__fingerprint__',
      breakdowns: [{
        campaignApr: 0.01, campaignId: '__fingerprint__-base',
        campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-01-01',
        campaignType: 'DUTCH_AUCTION',
      }],
    }],
    meritCampaignBorrows: [{
      link: '__fingerprint__',
      breakdowns: [{
        campaignApr: 0.01, campaignId: '__fingerprint__-base',
        campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-01-01',
        campaignType: 'DUTCH_AUCTION',
      }],
    }],
    merklSupplys: [{
      link: '__fingerprint__',
      breakdowns: [{
        campaignApr: 0.01, campaignId: '__fingerprint__',
        campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-01-01',
      }],
    }],
    merklBorrows: [{
      link: '__fingerprint__',
      breakdowns: [{
        campaignApr: 0.01, campaignId: '__fingerprint__',
        campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-01-01',
      }],
    }],
    merklHolds: [{
      link: '__fingerprint__',
      breakdowns: [{
        campaignApr: 0.01, campaignId: '__fingerprint__',
        campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-01-01',
      }],
    }],
    brevisSupplys: [{
      link: '__fingerprint__',
      breakdowns: [{
        campaignApr: 0.01, campaignId: '__fingerprint__',
        campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-01-01',
      }],
    }],
    brevisBorrows: [{
      link: '__fingerprint__',
      breakdowns: [{
        campaignApr: 0.01, campaignId: '__fingerprint__',
        campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-01-01',
      }],
    }],
    hubId: '__fingerprint__',
    hubName: '__fingerprint__',
    hubAddress: '0x0000000000000000000000000000000000000001',
    spokeId: '__fingerprint__',
    spokeName: '__fingerprint__',
    spokeAddress: '0x0000000000000000000000000000000000000001',
    collateralRisk: 5,
  };

  const serialized = serializeReserveForApi(canonical);
  const keyPaths = collectNestedKeyPaths(serialized).sort();
  _cachedFingerprint = createHash('sha256')
    .update(keyPaths.join(','))
    .digest('hex')
    .slice(0, 12);

  return _cachedFingerprint;
}

function collectNestedKeyPaths(obj: unknown, prefix: string = ''): string[] {
  if (obj === null || obj === undefined || typeof obj !== 'object') return [];
  const paths: string[] = [];
  if (Array.isArray(obj)) {
    if (obj.length > 0) {
      paths.push(...collectNestedKeyPaths(obj[0], prefix));
    }
    return paths;
  }
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    paths.push(path);
    const value = (obj as Record<string, unknown>)[key];
    if (value !== null && value !== undefined && typeof value === 'object') {
      paths.push(...collectNestedKeyPaths(value, path));
    }
  }
  return paths;
}
