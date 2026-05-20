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

export function computeIsExpired(endDate?: string | null, now?: Date): boolean {
  if (!endDate) return false;
  const ts = Date.parse(endDate);
  if (!Number.isFinite(ts)) return false;
  const refNow = now ?? new Date();
  return refNow.getTime() > ts;
}

export function roundTo6(n: number): number {
  return Number(n.toFixed(6));
}

function scaleMeritEntry<T extends { apr: number; selfApr?: number; endDate?: string }>(e: T, now?: Date): T & { _isExpired?: boolean } {
  const result: T & { _isExpired?: boolean } = {
    ...e,
    apr: roundTo6(e.apr * 100),
    ...(e.selfApr !== undefined ? { selfApr: roundTo6(e.selfApr * 100) } : {}),
  };
  if (e.endDate) {
    result._isExpired = computeIsExpired(e.endDate, now);
  }
  return result;
}

function scaleMerklBreakdown<
  T extends {
    campaignApr: number;
    aprCap?: number | null;
    campaignType?: CampaignForecastType;
    plannedDaily?: number;
    totalBudget?: number;
    campaignEndedAt?: string;
  },
>(b: T, now?: Date): T & { _isExpired?: boolean } {
  const next = { ...b, campaignApr: roundTo6(b.campaignApr * 100) } as T & { _isExpired?: boolean };
  if (Object.prototype.hasOwnProperty.call(b, 'aprCap')) {
    const cap = b.aprCap;
    (next as { aprCap?: number | null }).aprCap =
      cap === null || cap === undefined ? cap : roundTo6(cap * 100);
  }
  if (b.campaignType) {
    const rule = getBreakdownFieldRule(b.campaignType);
    for (const field of rule.omit) {
      delete (next as Record<string, unknown>)[field];
    }
  }
  if (b.campaignEndedAt) {
    next._isExpired = computeIsExpired(b.campaignEndedAt, now);
  }
  return next;
}

function scaleBrevisBreakdown<T extends { campaignApr: number; campaignEndedAt?: string }>(b: T, now?: Date): T & { _isExpired?: boolean } {
  const result: T & { _isExpired?: boolean } = { ...b, campaignApr: roundTo6(b.campaignApr * 100) };
  if (b.campaignEndedAt) {
    result._isExpired = computeIsExpired(b.campaignEndedAt, now);
  }
  return result;
}

function scaleGroupedCampaigns<
  TBreakdown extends { campaignApr: number },
  TGroup extends { breakdowns: TBreakdown[] },
>(groups: TGroup[] | undefined, scaleBreakdown: (breakdown: TBreakdown, now?: Date) => TBreakdown, now?: Date): TGroup[] | undefined {
  if (!groups?.length) return undefined;
  return groups.map((group) => ({
    ...group,
    breakdowns: group.breakdowns.map((bd) => scaleBreakdown(bd, now)),
  }));
}

export function serializeReserveForApi(reserve: RuntimeReserveData): MarketWithSpread {
  const now = new Date();

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
    ...(reserve.utilizationPct !== undefined ? { utilizationPct: reserve.utilizationPct } : {}),
    ...(reserve.aTokenAddress !== undefined ? { aTokenAddress: reserve.aTokenAddress } : {}),
    ...(reserve.vTokenAddress !== undefined ? { vTokenAddress: reserve.vTokenAddress } : {}),
    ...(reserve.supplyApy !== undefined ? { supplyApy: roundTo6(reserve.supplyApy * 100) } : {}),
    ...(reserve.supplyDisabled ? { supplyDisabled: true } : {}),
    ...(reserve.isFrozen ? { isFrozen: true } : {}),
    ...(reserve.isPaused ? { isPaused: true } : {}),
    ...(reserve.isActive === false ? { isActive: false as const } : {}),
    ...(reserve.borrowApy !== undefined ? { borrowApy: roundTo6(reserve.borrowApy * 100) } : {}),
    ...(reserve.borrowDisabled ? { borrowDisabled: true } : {}),
    ...(reserve.decimals !== undefined && reserve.decimals !== 18 ? { decimals: reserve.decimals } : {}),
    ...(reserve.liquidity ? { liquidity: reserve.liquidity } : {}),
    ...(reserve.borrowed ? { borrowed: reserve.borrowed } : {}),
    ...(reserve.supplied ? { supplied: reserve.supplied } : {}),
    ...(reserve.supplyCap ? { supplyCap: reserve.supplyCap } : {}),
    ...(reserve.borrowCap ? { borrowCap: reserve.borrowCap } : {}),
    ...(reserve.protocolFee ? { protocolFee: roundTo6(reserve.protocolFee) } : {}),
    ...(reserve.slopeBelowOptimal !== undefined ? { slopeBelowOptimal: roundTo6(reserve.slopeBelowOptimal) } : {}),
    ...(reserve.slopeAboveOptimal !== undefined ? { slopeAboveOptimal: roundTo6(reserve.slopeAboveOptimal) } : {}),
    ...(reserve.optimalUtilization !== undefined ? { optimalUtilization: roundTo6(reserve.optimalUtilization) } : {}),
    ...(reserve.baseBorrowRate !== undefined
      ? { baseBorrowRate: roundTo6(reserve.baseBorrowRate) }
      : {}),
    ...(reserve.deficit !== undefined ? { deficit: reserve.deficit } : {}),
    ...(reserve.meritSupplys?.length
      ? { meritSupplys: reserve.meritSupplys.map((e) => scaleMeritEntry(e, now)) }
      : {}),
    ...(reserve.meritBorrows?.length
      ? { meritBorrows: reserve.meritBorrows.map((e) => scaleMeritEntry(e, now)) }
      : {}),
    ...(reserve.merklSupplys?.length
      ? { merklSupplys: scaleGroupedCampaigns(reserve.merklSupplys, scaleMerklBreakdown, now) }
      : {}),
    ...(reserve.merklBorrows?.length
      ? { merklBorrows: scaleGroupedCampaigns(reserve.merklBorrows, scaleMerklBreakdown, now) }
      : {}),
    ...(reserve.merklHolds?.length
      ? { merklHolds: scaleGroupedCampaigns(reserve.merklHolds, scaleMerklBreakdown, now) }
      : {}),
    ...(reserve.brevisSupplys?.length
      ? { brevisSupplys: scaleGroupedCampaigns(reserve.brevisSupplys, scaleBrevisBreakdown, now) }
      : {}),
    ...(reserve.brevisBorrows?.length
      ? { brevisBorrows: scaleGroupedCampaigns(reserve.brevisBorrows, scaleBrevisBreakdown, now) }
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
