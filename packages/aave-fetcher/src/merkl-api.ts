import fetch from 'node-fetch';
import type { RequestInit, Response } from 'node-fetch';
import { mkdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { writeJsonAtomic } from './file-utils.js';
import { merklFetchConfig } from './config.js';
import {
  createMerklConcurrencyLimitedFetch,
  fetchMerklOpportunitiesSnapshot,
  normalizeMerklCampaignTotalBudget,
  resolveCacheTtlMs,
} from '@internal/aave-shared-config';
import type { MerklCampaignBreakdown, MerklOpportunityGroup, ForecastCampaignTypeLite, MerklCampaignAccess, RuntimeReserveData } from '@internal/aave-shared-contracts';
export type { MerklCampaignBreakdown, MerklOpportunityGroup, ForecastCampaignTypeLite, MerklCampaignAccess } from '@internal/aave-shared-contracts';
import { resolveUsdPriceWithPriority, type UsdPriceSource } from './token-price-resolver.js';

const merklLimitedFetch = createMerklConcurrencyLimitedFetch(
  fetch as unknown as typeof globalThis.fetch
) as unknown as typeof fetch;

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const RUNTIME_DATA_DIR = join(DATA_DIR, 'runtime');
const DEBUG_DATA_DIR = join(DATA_DIR, 'debug');
const MERKL_DEFAULT_OPPORTUNITIES_SOFT_TTL_MS = 1 * 60 * 1000;
const MERKL_DEFAULT_HARD_TTL_MS = 10 * 60 * 1000;

const OPPORTUNITIES_SOFT_TTL_MS = resolveCacheTtlMs(
  process.env.MERKL_OPPORTUNITIES_SOFT_TTL_MS,
  MERKL_DEFAULT_OPPORTUNITIES_SOFT_TTL_MS
);
const MERKL_HARD_TTL_MS = resolveCacheTtlMs(
  process.env.MERKL_HARD_TTL_MS,
  MERKL_DEFAULT_HARD_TTL_MS
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  const retryableCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETRESET', 'ECONNREFUSED']);
  // node-fetch errors surface via error.cause?.code or error.code
  const code = (error as any)?.code || (error as any)?.cause?.code;
  return Boolean(code && retryableCodes.has(String(code)));
}

async function fetchWithRetry(
  url: string,
  label: string,
  init?: RequestInit
): Promise<Response> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= merklFetchConfig.maxRetries) {
    try {
      const response = await merklLimitedFetch(url, init);
      if (response.ok) {
        return response;
      }
      // Only retry on 5xx / gateway errors
      if (response.status >= 500 && response.status < 600 && attempt < merklFetchConfig.maxRetries) {
        const delay = Math.min(
          merklFetchConfig.maxDelayMs,
          merklFetchConfig.baseDelayMs * Math.pow(2, attempt)
        ) + Math.random() * 250;
        logger.warn(`⚠️ ${label} HTTP ${response.status}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${merklFetchConfig.maxRetries})`);
        await sleep(delay);
        attempt++;
        continue;
      }
      // Non-retryable HTTP error
      return response;
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt >= merklFetchConfig.maxRetries) {
        throw error;
      }
      const delay = Math.min(
        merklFetchConfig.maxDelayMs,
        merklFetchConfig.baseDelayMs * Math.pow(2, attempt)
      ) + Math.random() * 250;
      logger.warn(`⚠️ ${label} network error (${(error as Error).message}), retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${merklFetchConfig.maxRetries})`);
      await sleep(delay);
      attempt++;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// API 响应的完整类型（用于类型断言）
export interface MerklOpportunity {
  id: string;
  name?: string; // opportunity name for market detection
  description?: string; // opportunity description
  action: string; // "LEND" or "BORROW" or "HOLD"
  chainId: number;
  chain?: {
    name: string; // 链名称，用于构建链接（如 "Ethereum", "Plasma"）
  };
  explorerAddress?: string; // 用于索引的地址
  identifier?: string; // 用于构建 Merkl opportunity 链接的标识符
  type?: string; // opportunity 类型，用于构建链接（如 MULTILOG_DUTCH, EULER 等）
  distributionType?: string;
  status?: string; // "LIVE" or other statuses
  tvl?: number; // TVL 值，用于计算 points/1000USD
  protocol?: {
    id: string;
  };
  tokens?: Array<{
    address: string;
    symbol: string;
    name: string;
    chainId?: number;
    price?: number;
    updatedAt?: number;
  }>; // 可选：处理逻辑中未使用
  rewardsRecord: {
    breakdowns: Array<{
      campaignId: string; // 实际使用的字段
      distributionType?: string;
      distributionMethod?: string;
      value?: number;
      token?: {
        address?: string;
        symbol?: string;
        name?: string;
        type?: string;
        chainId?: number;
        price?: number;
        updatedAt?: number;
      };
      // API 可能返回其他字段，但处理逻辑中未使用
    }>;
  };
  campaigns?: MerklEmbeddedCampaign[];
}

interface MerklEmbeddedCampaign {
  id?: string;
  campaignId?: string;
  startTimestamp?: string | number | bigint;
  endTimestamp?: string | number | bigint;
  apr?: number;
  params?: any;
}

export interface MerklCampaignDetails {
  startedAt: string;
  endedAt: string;
  id: string;
  /** Annual yield ratio; upstream `campaign.apr` is percent → divided by 100 when cached. */
  apr: number;
  whitelistOnly: boolean;
}

const hasEntries = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return Boolean(value);
};

export function isCampaignWhitelistOnly(campaign: any): boolean {
  const topLevelWhitelist = hasEntries(campaign?.params?.whitelist);
  if (topLevelWhitelist) return true;

  const composedCampaigns = campaign?.params?.composedCampaigns;
  if (!Array.isArray(composedCampaigns)) return false;

  return composedCampaigns.some((entry: any) => hasEntries(entry?.campaignParameters?.whitelist));
}

const toIsoFromUnixLike = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const numeric =
    typeof value === 'bigint'
      ? Number(value)
      : typeof value === 'string'
        ? Number(value)
        : typeof value === 'number'
          ? value
          : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  const ms = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  return new Date(ms).toISOString();
};

// Merkl 数据结构：每个 opportunity 存储一次
export interface NetPositionConstraint {
  sourceSide: 'supply' | 'borrow';
  offsetReserveIds: string[];
}

export interface OffsetTokenInfo {
  address: string;
  reserveId?: string;
}

export function inferVersionFromReserveId(reserveId: string): 'v3' | 'v4' | null {
  const segments = reserveId.split(':').length;
  if (segments === 3) return 'v3';
  if (segments >= 4) return 'v4';
  return null;
}

export function extractPoolSpokePrefix(reserveId: string): string | null {
  const parts = reserveId.split(':');
  if (parts.length < 3) return null;
  return `${parts[0]}:${parts[1]}`;
}

export function resolveOffsetReserveIds(
  oppReserveId: string,
  offsetTokenAddress: string,
  reserveIdSet: Set<string>,
): string[] {
  const version = inferVersionFromReserveId(oppReserveId);
  const prefix = extractPoolSpokePrefix(oppReserveId);
  if (!prefix || !version) return [];

  const normalizedAddr = offsetTokenAddress.toLowerCase();

  if (version === 'v3') {
    const candidate = `${prefix}:${normalizedAddr}`;
    return reserveIdSet.has(candidate) ? [candidate] : [];
  }

  const base = `${prefix}:${normalizedAddr}`;
  const results: string[] = [];
  for (const rid of reserveIdSet) {
    if (rid.startsWith(base + ':')) {
      results.push(rid);
    }
  }
  return results;
}

export interface MerklOpportunityData {
  supply: MerklCampaignBreakdown[];
  borrow: MerklCampaignBreakdown[];
  hold: MerklCampaignBreakdown[];
  marketName: string;
  chainId: number;
  /** Protocol version derived from Merkl opportunity type (e.g. AAVE_V4_HUB_SUPPLY = v4). */
  protocolVersion: 'v3' | 'v4';
  opportunityLink?: string;
  name?: string;
  description?: string;
  opportunityType?: string;
  offsetTokenAddresses?: OffsetTokenInfo[];
}

/**
 * Build protocol version lookup tables from baseDataset.
 * 
 * Unambiguous lookup: chainId + aToken/vToken/spoke address → version.
 *   - V3 reserves contribute aToken/vToken
 *   - V4 reserves contribute aToken/vToken + spokeAddress
 * 
 * V4 underlying lookup: chainId + underlying token → true (V4 only).
 *   - V3 reserves are excluded because V3 never uses underlying token as explorerAddress.
 *   - This handles V4 Hub Supply where explorerAddress = underlying token.
 */
export function buildProtocolVersionLookup(
  baseDataset: RuntimeReserveData[]
): {
  unambiguous: Map<string, 'v3' | 'v4'>;
  v4Underlying: Map<string, true>;
} {
  const unambiguous = new Map<string, 'v3' | 'v4'>();
  const v4Underlying = new Map<string, true>();

  for (const r of baseDataset) {
    const isV4 = r.marketName.startsWith('AaveV4');
    const version: 'v3' | 'v4' = isV4 ? 'v4' : 'v3';
    const chainId = r.chainId;

    if (r.aTokenAddress) {
      unambiguous.set(`${chainId}:${r.aTokenAddress.toLowerCase()}`, version);
    }
    if (r.vTokenAddress) {
      unambiguous.set(`${chainId}:${r.vTokenAddress.toLowerCase()}`, version);
    }
    if (r.spokeAddress) {
      unambiguous.set(`${chainId}:${r.spokeAddress.toLowerCase()}`, version);
    }

    // V4 underlying token → separate lookup (shared with V3, so unambiguous lookup can't use it)
    if (isV4 && r.tokenAddress) {
      v4Underlying.set(`${chainId}:${r.tokenAddress.toLowerCase()}`, true);
    }
  }

  return { unambiguous, v4Underlying };
}

/**
 * Derive protocol version from Merkl opportunity data.
 * 
 * Priority (ADR-0018):
 *   1. type starts with AAVE_V4_           → v4  (zero-cost: Merkl naming convention)
 *   2. Unambiguous address lookup (aToken/vToken/spoke) → v3/v4
 *   3. V4 underlying token lookup           → v4  (safe: V3 never uses underlying as explorerAddress)
 *   4. Default                               → v3  (conservative)
 */
export function deriveProtocolVersion(
  opportunityType: string | undefined,
  explorerAddress: string | undefined,
  chainId: number,
  unambiguousLookup: Map<string, 'v3' | 'v4'>,
  v4UnderlyingLookup: Map<string, true>,
): 'v3' | 'v4' {
  // Step 1: type prefix check (fastest, catches all current V4 types)
  if (opportunityType && opportunityType.toUpperCase().startsWith('AAVE_V4_')) {
    return 'v4';
  }

  if (!explorerAddress) {
    return 'v3';
  }

  const key = `${chainId}:${explorerAddress.toLowerCase()}`;

  // Step 2: unambiguous address lookup
  const version = unambiguousLookup.get(key);
  if (version) return version;

  // Step 3: V4 underlying token lookup
  if (v4UnderlyingLookup.has(key)) return 'v4';

  // Step 4: default
  return 'v3';
}

interface CampaignSnapshotLiteForForecastFile {
  id: string;
  amount?: unknown;
  startTimestamp?: unknown;
  endTimestamp?: unknown;
  rewardToken?: {
    address?: unknown;
    symbol?: unknown;
    price?: unknown;
    decimals?: unknown;
  };
  params?: {
    decimalsRewardToken?: unknown;
    distributionMethodParameters?: {
      distributionSettings?: {
        apr?: unknown;
      };
    };
  };
}

interface ForecastCampaignMetaLite {
  chainId: number;
  tvl: number;
  campaignTypeHint: ForecastCampaignTypeLite;
  campaignSnapshot: CampaignSnapshotLiteForForecastFile | null;
  useTokenRateInMetrics: boolean;
}

interface ProcessMerklDataOptions {
  reserveTokenPriceByChainAndAddress?: Map<string, number>;
  priceSourceStats?: Record<UsdPriceSource, number>;
  reserveIdSet?: Set<string>;
  baseDataset?: RuntimeReserveData[];
}

interface MerklStaleStatus {
  stale: boolean;
  reason?: string;
  fallbackSource?: 'memory' | 'disk';
  lastSuccessfulAt?: string;
  lastFetchError?: string;
  fetchedOpportunities: number;
  usedOpportunities: number;
}

interface MerklArtifactsPayload {
  rawOpportunities: MerklOpportunity[];
  liveOpportunities: MerklOpportunity[];
  processedData: MerklOpportunityData[];
  index: Record<string, MerklOpportunityData[]>;
  forecastCampaignMetaLite: Record<string, ForecastCampaignMetaLite>;
  staleStatus: MerklStaleStatus;
}

interface MerklFallbackSnapshot {
  source: 'memory' | 'disk';
  rawOpportunities: MerklOpportunity[];
  liveOpportunities: MerklOpportunity[];
  processedData: MerklOpportunityData[];
  index: Record<string, MerklOpportunityData[]>;
  forecastCampaignMetaLite: Record<string, ForecastCampaignMetaLite>;
  lastSuccessfulAt?: string;
}

interface MerklSuccessfulSnapshot {
  rawOpportunities: MerklOpportunity[];
  liveOpportunities: MerklOpportunity[];
  processedData: MerklOpportunityData[];
  index: Record<string, MerklOpportunityData[]>;
  forecastCampaignMetaLite: Record<string, ForecastCampaignMetaLite>;
  lastSuccessfulAt?: string;
}

const _merklState = {
  lastSuccessfulSnapshot: null as MerklSuccessfulSnapshot | null,
  lastFetchError: null as string | null,
};

/** @internal test-only hook to reset all mutable state */
export function resetMerklState(): void {
  _merklState.lastSuccessfulSnapshot = null;
  _merklState.lastFetchError = null;
}

const getRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const isNonEmptyIndex = (value: unknown): value is Record<string, MerklOpportunityData[]> => {
  const record = getRecord(value);
  return Boolean(record && Object.keys(record).length > 0);
};

const readDiskFallbackSnapshot = async (): Promise<MerklFallbackSnapshot | null> => {
  try {
    const merklRawDataPath = join(DEBUG_DATA_DIR, 'merkl-raw-data.json');
    const rawJson = JSON.parse(await readFile(merklRawDataPath, 'utf-8')) as Record<string, unknown>;
    const indexRaw = rawJson.index;
    if (!isNonEmptyIndex(indexRaw)) return null;
    const index = indexRaw as Record<string, MerklOpportunityData[]>;

    const rawOpportunities = Array.isArray(rawJson.rawOpportunities)
      ? (rawJson.rawOpportunities as MerklOpportunity[])
      : [];
    const liveOpportunities = Array.isArray(rawJson.liveOpportunities)
      ? (rawJson.liveOpportunities as MerklOpportunity[])
      : rawOpportunities;
    const processedData = Array.isArray(rawJson.processedData)
      ? (rawJson.processedData as MerklOpportunityData[])
      : Object.values(index).flat();

    let forecastCampaignMetaLite: Record<string, ForecastCampaignMetaLite> = {};
    try {
      const merklForecastLitePath = join(RUNTIME_DATA_DIR, 'merkl-opportunity-meta-lite.json');
      const liteJson = JSON.parse(await readFile(merklForecastLitePath, 'utf-8')) as Record<string, unknown>;
      const campaigns = getRecord(liteJson.campaigns);
      if (campaigns) {
        forecastCampaignMetaLite = campaigns as unknown as Record<string, ForecastCampaignMetaLite>;
      }
    } catch {
      forecastCampaignMetaLite = buildForecastCampaignMetaLiteMap(liveOpportunities);
    }

    return {
      source: 'disk',
      rawOpportunities,
      liveOpportunities,
      processedData,
      index,
      forecastCampaignMetaLite,
      lastSuccessfulAt: typeof rawJson.timestamp === 'string' ? rawJson.timestamp : undefined,
    };
  } catch {
    return null;
  }
};

const resolveMerklFallbackSnapshot = async (): Promise<MerklFallbackSnapshot | null> => {
  const memorySnapshot = _merklState.lastSuccessfulSnapshot;
  if (memorySnapshot !== null && Object.keys(memorySnapshot.index).length > 0) {
    return {
      source: 'memory',
      rawOpportunities: memorySnapshot.rawOpportunities,
      liveOpportunities: memorySnapshot.liveOpportunities,
      processedData: memorySnapshot.processedData,
      index: memorySnapshot.index,
      forecastCampaignMetaLite: memorySnapshot.forecastCampaignMetaLite,
      lastSuccessfulAt: memorySnapshot.lastSuccessfulAt,
    };
  }
  return readDiskFallbackSnapshot();
};

const getSnapshotAgeMs = (iso?: string): number | null => {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return Math.max(0, Date.now() - ts);
};

const isFallbackSnapshotFreshEnough = (snapshot: MerklFallbackSnapshot): boolean => {
  const ageMs = getSnapshotAgeMs(snapshot.lastSuccessfulAt);
  if (ageMs === null) return false;
  return ageMs <= MERKL_HARD_TTL_MS;
};

const persistMerklArtifacts = async (payload: MerklArtifactsPayload): Promise<void> => {
  await mkdir(DEBUG_DATA_DIR, { recursive: true });
  await mkdir(RUNTIME_DATA_DIR, { recursive: true });

  const merklRawDataPath = join(DEBUG_DATA_DIR, 'merkl-raw-data.json');
  await writeJsonAtomic(merklRawDataPath, {
    timestamp: new Date().toISOString(),
    stale: payload.staleStatus,
    rawOpportunities: payload.rawOpportunities,
    liveOpportunities: payload.liveOpportunities,
    processedData: payload.processedData,
    index: payload.index,
  });
  logger.info(
    `💾 Merkl raw data saved to ${merklRawDataPath}${payload.staleStatus.stale ? ' (stale fallback)' : ''}`
  );

  const merklForecastLitePath = join(RUNTIME_DATA_DIR, 'merkl-opportunity-meta-lite.json');
  await writeJsonAtomic(
    merklForecastLitePath,
    {
      timestamp: new Date().toISOString(),
      stale: payload.staleStatus,
      campaigns: payload.forecastCampaignMetaLite,
    },
    { space: 0 }
  );
  logger.info(
    `💾 Merkl forecast lite data saved to ${merklForecastLitePath}${payload.staleStatus.stale ? ' (stale fallback)' : ''}`
  );
};

const normalizeForecastCampaignTypeLite = (value: unknown): ForecastCampaignTypeLite | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  if (!normalized) return null;
  if (normalized.includes('MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE')) {
    return 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE';
  }
  if (normalized.includes('DUTCH_AUCTION')) {
    return 'DUTCH_AUCTION';
  }
  if (normalized.includes('FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE')) {
    return 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE';
  }
  if (normalized.includes('AAVE_NET_APR')) {
    return 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE';
  }
  if (normalized.includes('AAVE_V4_NET_APR')) {
    return 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE';
  }
  return null;
};

const buildCampaignSnapshotLiteForForecastFile = (campaign: any): CampaignSnapshotLiteForForecastFile | null => {
  const id = typeof campaign?.id === 'string' ? campaign.id : String(campaign?.id || '').trim();
  if (!id) return null;

  const snapshot: CampaignSnapshotLiteForForecastFile = { id };
  if (campaign?.amount !== undefined) snapshot.amount = campaign.amount;
  if (campaign?.startTimestamp !== undefined) snapshot.startTimestamp = campaign.startTimestamp;
  if (campaign?.endTimestamp !== undefined) snapshot.endTimestamp = campaign.endTimestamp;
  if (campaign?.rewardToken) {
    const rewardToken: CampaignSnapshotLiteForForecastFile['rewardToken'] = {};
    if (campaign.rewardToken.address !== undefined) rewardToken.address = campaign.rewardToken.address;
    if (campaign.rewardToken.symbol !== undefined) rewardToken.symbol = campaign.rewardToken.symbol;
    if (campaign.rewardToken.price !== undefined) rewardToken.price = campaign.rewardToken.price;
    if (campaign.rewardToken.decimals !== undefined) rewardToken.decimals = campaign.rewardToken.decimals;
    if (Object.keys(rewardToken).length > 0) snapshot.rewardToken = rewardToken;
  }
  if (campaign?.params) {
    const params: CampaignSnapshotLiteForForecastFile['params'] = {};
    if (campaign.params.decimalsRewardToken !== undefined) {
      params.decimalsRewardToken = campaign.params.decimalsRewardToken;
    }
    const apr = campaign.params?.distributionMethodParameters?.distributionSettings?.apr;
    if (apr !== undefined) {
      params.distributionMethodParameters = { distributionSettings: { apr } };
    }
    if (Object.keys(params).length > 0) snapshot.params = params;
  }
  return snapshot;
};

const buildForecastCampaignMetaLiteMap = (
  opportunities: MerklOpportunity[]
): Record<string, ForecastCampaignMetaLite> => {
  const result: Record<string, ForecastCampaignMetaLite> = {};

  for (const opp of opportunities) {
    const tvl = Number(opp?.tvl);
    if (!Number.isFinite(tvl) || tvl < 0) continue;

    const breakdowns = opp?.rewardsRecord?.breakdowns;
    if (!Array.isArray(breakdowns) || breakdowns.length === 0) continue;

    const campaignSnapshotById = new Map<string, CampaignSnapshotLiteForForecastFile>();
    if (Array.isArray(opp.campaigns)) {
      for (const campaign of opp.campaigns) {
        const snapshot = buildCampaignSnapshotLiteForForecastFile(campaign);
        if (snapshot) campaignSnapshotById.set(snapshot.id, snapshot);
      }
    }

    for (const breakdown of breakdowns) {
      const campaignId = String(breakdown?.campaignId || '').trim();
      if (!campaignId) continue;

      const rawType =
        (typeof breakdown?.distributionType === 'string' && breakdown.distributionType) ||
        (typeof breakdown?.distributionMethod === 'string' && breakdown.distributionMethod) ||
        (typeof opp?.distributionType === 'string' && opp.distributionType) ||
        null;

      const campaignTypeHint = normalizeForecastCampaignTypeLite(rawType);
      if (!campaignTypeHint) continue;

      const existing = result[campaignId];
      const campaignSnapshot = campaignSnapshotById.get(campaignId) ?? null;
      const useTokenRateInMetrics = merklBreakdownUsesPointsIntensityFields(breakdown);

      if (!existing) {
        result[campaignId] = {
          chainId: opp.chainId,
          tvl,
          campaignTypeHint,
          campaignSnapshot,
          useTokenRateInMetrics,
        };
        continue;
      }

      result[campaignId] = {
        chainId: existing.chainId > 0 ? existing.chainId : opp.chainId,
        tvl: existing.tvl > 0 ? existing.tvl : tvl,
        campaignTypeHint: existing.campaignTypeHint,
        campaignSnapshot: existing.campaignSnapshot ?? campaignSnapshot,
        useTokenRateInMetrics: existing.useTokenRateInMetrics || useTokenRateInMetrics,
      };
    }
  }

  return result;
};

const toFiniteNumberForForecast = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

interface ForecastFieldsFlat {
  campaignType: ForecastCampaignTypeLite;
  totalBudget: number;
  aprCap?: number;
  latestTvl: number;
  plannedDaily: number;
}

/**
 * Compute opportunity-only forecast fields for a campaign.
 * Uses only data available from the opportunity snapshot (no metrics API needed).
 */
const buildForecastFieldsFromOpportunity = async (
  meta: ForecastCampaignMetaLite,
  options?: ProcessMerklDataOptions
): Promise<ForecastFieldsFlat | null> => {
  const snapshot = meta.campaignSnapshot;
  if (!snapshot) return null;

  const startTs = toFiniteNumberForForecast(snapshot.startTimestamp);
  const endTs = toFiniteNumberForForecast(snapshot.endTimestamp);
  if (startTs === null || endTs === null || endTs <= startTs) return null;

  const rawPrice =
    snapshot.rewardToken?.price !== undefined
      ? Number(snapshot.rewardToken.price)
      : undefined;
  const normalizedPrice = Number.isFinite(rawPrice) && rawPrice! > 0 ? rawPrice : undefined;
  if (!meta.useTokenRateInMetrics && normalizedPrice !== undefined && options?.priceSourceStats) {
    options.priceSourceStats.snapshot += 1;
  }

  let effectiveSnapshot = snapshot;
  if (!meta.useTokenRateInMetrics && normalizedPrice === undefined) {
    const reserveTokenAddress =
      typeof snapshot.rewardToken?.address === 'string' ? snapshot.rewardToken.address.toLowerCase() : '';
    const reservePriceKey = `${meta.chainId}:${reserveTokenAddress}`;
    const reserveTokenPrice =
      reserveTokenAddress && options?.reserveTokenPriceByChainAndAddress
        ? options.reserveTokenPriceByChainAndAddress.get(reservePriceKey)
        : undefined;
    const normalizedReserveTokenPrice =
      typeof reserveTokenPrice === 'number' && Number.isFinite(reserveTokenPrice) && reserveTokenPrice > 0
        ? reserveTokenPrice
        : undefined;

    if (normalizedReserveTokenPrice !== undefined) {
      effectiveSnapshot = {
        ...snapshot,
        rewardToken: {
          ...(snapshot.rewardToken ?? {}),
          price: normalizedReserveTokenPrice,
        },
      };
    }
  }

  if (!meta.useTokenRateInMetrics && normalizedPrice === undefined) {
    const resolved = await resolveUsdPriceWithPriority({
      chainId: meta.chainId,
      tokenAddress:
        typeof snapshot.rewardToken?.address === 'string' ? snapshot.rewardToken.address : undefined,
      tokenSymbol:
        typeof snapshot.rewardToken?.symbol === 'string' ? snapshot.rewardToken.symbol : undefined,
      snapshotPrice: undefined,
      reservePrice:
        typeof effectiveSnapshot.rewardToken?.price === 'number' &&
        Number.isFinite(effectiveSnapshot.rewardToken.price) &&
        effectiveSnapshot.rewardToken.price > 0
          ? effectiveSnapshot.rewardToken.price
          : undefined,
    });
    if (options?.priceSourceStats) {
      options.priceSourceStats[resolved.source] += 1;
    }

    if (resolved.price !== undefined && resolved.price > 0) {
      effectiveSnapshot = {
        ...snapshot,
        rewardToken: {
          ...(snapshot.rewardToken ?? {}),
          price: resolved.price,
        },
      };
    }
  }

  const totalBudget = normalizeMerklCampaignTotalBudget(effectiveSnapshot);
  if (totalBudget === null) return null;
  if (totalBudget <= 0) return null;

  // For non-PRETGE (non-points) campaigns, do not emit token-unit fallback values.
  if (!meta.useTokenRateInMetrics) {
    const resolvedPrice = Number(effectiveSnapshot.rewardToken?.price);
    if (!Number.isFinite(resolvedPrice) || resolvedPrice <= 0) {
      logger.warn(
        `⚠️ Skipping forecast budget fields for campaign ${snapshot.id}: missing USD price (chainId=${meta.chainId}, token=${String(
          effectiveSnapshot.rewardToken?.symbol || ''
        )})`
      );
      return null;
    }
  }

  const totalDays = Math.max((endTs - startTs) / 86400, 0.0001);
  const plannedDaily = totalBudget / totalDays;

  const fields: ForecastFieldsFlat = {
    campaignType: meta.campaignTypeHint,
    totalBudget,
    latestTvl: meta.tvl,
    plannedDaily,
  };

  // APR cap (only for MAX/FIX reward types)
  if (
    meta.campaignTypeHint === 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' ||
    meta.campaignTypeHint === 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  ) {
    const rawApr = snapshot.params?.distributionMethodParameters?.distributionSettings?.apr;
    const aprValue = toFiniteNumberForForecast(rawApr);
    if (aprValue !== null && aprValue > 0) {
      fields.aprCap = aprValue;
    }
  }

  return fields;
};

/**
 * 获取 Merkl opportunities（使用 mainProtocolId 参数，返回 Aave 和 Tydro 相关的数据）
 */
export async function fetchMerklOpportunities(): Promise<MerklOpportunity[]> {
  try {
    logger.info('🔄 Fetching Merkl opportunities for Aave + Tydro (LIVE, campaigns=true, short-page pagination)...');
    const allOpportunities = (await fetchMerklOpportunitiesSnapshot({
      baseUrl: 'https://api.merkl.xyz/v4',
      ttlMs: OPPORTUNITIES_SOFT_TTL_MS,
      fetchImpl: fetch as unknown as typeof globalThis.fetch,
    })) as MerklOpportunity[];
    _merklState.lastFetchError = null;
    logger.info(`✅ Fetched ${allOpportunities.length} live opportunities from Merkl`);
    return allOpportunities;
  } catch (error) {
    logger.error('❌ Error fetching Merkl opportunities:', error);
    _merklState.lastFetchError = error instanceof Error ? error.message : String(error);
    return [];
  }
}

/**
 * 获取 Merkl campaign 详情
 * In https://api.merkl.xyz/v4/opportunities?mainProtocolId=aave api, onChainCampaignId = Campaign ID in webpage, campaignId = Database ID in web page. 
 * https://api.merkl.xyz/v4/campaigns/${campaignId} use the second one Database ID as input parameter, but in response, their campaignId equals to the first one onChainCampaignId
 */
export async function fetchMerklCampaignDetails(campaignId: string): Promise<MerklCampaignDetails | null> {
  try {
    const response = await fetchWithRetry(
      `https://api.merkl.xyz/v4/campaigns/${campaignId}`,
      `Merkl campaign ${campaignId}`
    );
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const campaign = await response.json() as any;
    
    // 将 timestamp 转换为日期字符串
    const startedAt = campaign.startTimestamp ? 
      new Date(campaign.startTimestamp * 1000).toISOString() : 
      '';
    const endedAt = campaign.endTimestamp ? 
      new Date(campaign.endTimestamp * 1000).toISOString() : 
      '';
    
    const aprPercent = Number(campaign.apr || 0);
    return {
      startedAt,
      endedAt,
      id: campaignId,
      apr: aprPercent / 100,
      whitelistOnly: isCampaignWhitelistOnly(campaign),
    };
  } catch (error) {
    logger.error(`❌ Error fetching campaign ${campaignId}:`, error);
    return null;
  }
}

/**
 * 生成 Merkl opportunity 详情页链接
 * 格式：https://app.merkl.xyz/opportunities/{chainName}/{type}/{identifier}
 * 
 * @param opportunity Merkl opportunity 对象
 * @returns Merkl opportunity 详情页的完整 URL，如果缺少必要字段则返回 null
 */
export function generateMerklOpportunityLink(opportunity: MerklOpportunity): string | null {
  // 需要 identifier、type 和 chain.name 字段来构建链接
  if (!opportunity.identifier || !opportunity.type || !opportunity.chain?.name) {
    return null;
  }
  
  // 将链名称转换为小写（Merkl URL 使用小写链名称）
  const chainName = opportunity.chain.name.toLowerCase();
  const baseUrl = 'https://app.merkl.xyz';
  const link = `${baseUrl}/opportunities/${chainName}/${opportunity.type}/${opportunity.identifier}`;
  
  return link;
}

/**
 * 从 Merkl opportunity name 解析对应的 Aave market name
 * 规则：
 * - 如果 name 包含 "horizon" → AaveV3EthereumHorizon
 * - 如果 name 包含 "prime" → AaveV3EthereumLido
 * - 如果 name 包含 "EtherFi" → AaveV3EthereumEtherFi
 * - 如果都不包含 → AaveV3Ethereum (默认)
 */
export function parseMarketNameFromOpportunityName(opportunityName: string | undefined, chainId: number): string {
  if (!opportunityName) {
    // 如果没有 name，根据 chainId 返回默认值
    return chainId === 1 ? 'AaveV3Ethereum' : 'Unknown';
  }
  
  const nameLower = opportunityName.toLowerCase();
  
  // 只对 chainId 1 (Ethereum) 进行特殊市场解析
  if (chainId === 1) {
    if (nameLower.includes('horizon')) {
      return 'AaveV3EthereumHorizon';
    } else if (nameLower.includes('prime')) {
      return 'AaveV3EthereumLido';
    } else if (nameLower.includes('etherfi')) {
      return 'AaveV3EthereumEtherFi';
    } else {
      return 'AaveV3Ethereum';
    }
  }
  
  // 对于其他 chainId，返回默认值（可以根据需要扩展）
  return 'Unknown';
}


/**
 * 处理 Merkl 数据，构建索引并返回
 * Merkl 索引：explorerAddress -> opportunities
 * 对于 chainId === 1，使用 marketName-chainId-explorerAddress 作为 key
 * 对于其他 chainId，使用 chainId-explorerAddress 作为 key
 */
/**
 * 当 Merkl breakdown 提供 `value` 且可解析为有限数时，推导每千刀 TVL 强度。
 */
export function merklPointsFieldsFromBreakdownValue(
  opp: MerklOpportunity,
  rewardsBreakdown: { value?: number }
): { pointsPerThousandUsd: number } | undefined {
  if (rewardsBreakdown.value === undefined) {
    return undefined;
  }
  const rewardUnits = Number(rewardsBreakdown.value);
  if (!Number.isFinite(rewardUnits)) {
    return undefined;
  }
  const tvl = Number(opp.tvl) || 0;
  const pointsPerThousandUsd = tvl > 0 ? (rewardUnits / tvl) * 1000 : 0;
  return { pointsPerThousandUsd };
}

export type MerklRewardsBreakdownForIntensity = {
  token?: { type?: string; symbol?: string; name?: string };
};

/**
 * 是否应为该 breakdown 输出 `pointsPerThousandUsd`（由 `value`÷TVL 推导）。
 * 仅当 Merkl 在 breakdown 上把奖励标为 **`token.type === 'PRETGE'`**（pre-TGE 类积分）时启用。
 * 这只决定是否输出 points/intensity 字段，不决定 forecast 规则；forecast 仍按实际
 * `distributionType` / 规范化后的 `campaignType` 处理，不对 Tydro points 预设单独机制。
 */
export function merklBreakdownUsesPointsIntensityFields(
  breakdown: MerklRewardsBreakdownForIntensity
): boolean {
  return String(breakdown.token?.type || '').trim().toUpperCase() === 'PRETGE';
}

export async function processMerklData(
  options?: ProcessMerklDataOptions
): Promise<{ index: Record<string, MerklOpportunityData[]>; campaignAccess: MerklCampaignAccess[] }> {
  const priceSourceStats: Record<UsdPriceSource, number> = {
    snapshot: 0,
    reserve: 0,
    coingecko: 0,
    missing: 0,
  };
  const fetchedOpportunities = await fetchMerklOpportunities();
  const mergedOptions: ProcessMerklDataOptions = {
    ...options,
    priceSourceStats,
  };

  // Build protocol version lookup tables from baseDataset (ADR-0018)
  const protocolLookup = options?.baseDataset
    ? buildProtocolVersionLookup(options.baseDataset)
    : { unambiguous: new Map<string, 'v3' | 'v4'>(), v4Underlying: new Map<string, true>() };
  let opportunities = fetchedOpportunities;
  let staleStatus: MerklStaleStatus = {
    stale: false,
    fetchedOpportunities: fetchedOpportunities.length,
    usedOpportunities: fetchedOpportunities.length,
  };

  if (fetchedOpportunities.length === 0) {
    const fallback = await resolveMerklFallbackSnapshot();
    if (fallback && isFallbackSnapshotFreshEnough(fallback)) {
      const fallbackAgeMs = fallback.lastSuccessfulAt
        ? Date.now() - new Date(fallback.lastSuccessfulAt).getTime()
        : null;
      logger.warn(
        `⚠️ Merkl opportunities empty; reusing ${fallback.source} fallback snapshot (${Object.keys(fallback.index).length} token keys${
          fallbackAgeMs !== null && Number.isFinite(fallbackAgeMs)
            ? `, age=${Math.max(0, Math.round(fallbackAgeMs / 1000))}s`
            : ''
        })`
      );

      await persistMerklArtifacts({
        rawOpportunities: fallback.rawOpportunities,
        liveOpportunities: fallback.liveOpportunities,
        processedData: fallback.processedData,
        index: fallback.index,
        forecastCampaignMetaLite: fallback.forecastCampaignMetaLite,
        staleStatus: {
          stale: true,
          reason: 'merkl-opportunities-empty',
          fallbackSource: fallback.source,
          lastSuccessfulAt: fallback.lastSuccessfulAt,
          ...(_merklState.lastFetchError ? { lastFetchError: _merklState.lastFetchError } : {}),
          fetchedOpportunities: fetchedOpportunities.length,
          usedOpportunities: fallback.liveOpportunities.length,
        },
      });

      _merklState.lastSuccessfulSnapshot = {
        rawOpportunities: fallback.rawOpportunities,
        liveOpportunities: fallback.liveOpportunities,
        processedData: fallback.processedData,
        index: fallback.index,
        forecastCampaignMetaLite: fallback.forecastCampaignMetaLite,
        lastSuccessfulAt: fallback.lastSuccessfulAt,
      };

      return { index: fallback.index, campaignAccess: [] };
    }

    if (fallback && !isFallbackSnapshotFreshEnough(fallback)) {
      const fallbackAgeMs = getSnapshotAgeMs(fallback.lastSuccessfulAt);
      logger.warn(
        `⚠️ Merkl fallback snapshot expired (max ${Math.round(MERKL_HARD_TTL_MS / 1000)}s, age=${
          fallbackAgeMs === null ? 'unknown' : `${Math.round(fallbackAgeMs / 1000)}s`
        }); refusing stale fallback`
      );
    }

    logger.warn('⚠️ Merkl opportunities empty and no fallback snapshot available; continuing with empty result');
    staleStatus = {
      stale: true,
      reason: fallback ? 'merkl-opportunities-empty-fallback-expired' : 'merkl-opportunities-empty-no-fallback',
      ...(_merklState.lastFetchError ? { lastFetchError: _merklState.lastFetchError } : {}),
      fetchedOpportunities: fetchedOpportunities.length,
      usedOpportunities: 0,
    };
  }

  const merklData: Record<string, MerklOpportunityData[]> = {};
  logger.info('🔍 Processing Merkl opportunities...');
  // fetchMerklOpportunities 已在 API 层过滤 status=LIVE
  const liveOpportunities = opportunities;
  logger.info(`Processing ${liveOpportunities.length} live Merkl opportunities`);
  
  const campaignDetailsCache = new Map<string, MerklCampaignDetails | null>();
  const campaignAccessMap = new Map<string, MerklCampaignAccess>();
  for (const opp of liveOpportunities) {
    if (!Array.isArray(opp.campaigns)) continue;
    opp.campaigns.forEach((campaign) => {
      const id = String(campaign.id || '').trim();
      if (!id) return;
      if (campaignDetailsCache.has(id)) return;
      campaignDetailsCache.set(id, {
        startedAt: toIsoFromUnixLike(campaign.startTimestamp),
        endedAt: toIsoFromUnixLike(campaign.endTimestamp),
        id,
        apr: Number(campaign.apr || 0) / 100,
        whitelistOnly: isCampaignWhitelistOnly(campaign),
      });
      const params = campaign.params ?? {};
      const wl = Array.isArray(params.whitelist) ? (params.whitelist as string[]).filter(Boolean) : [];
      const bl = Array.isArray(params.blacklist) ? (params.blacklist as string[]).filter(Boolean) : [];
      if (wl.length > 0 || bl.length > 0) {
        campaignAccessMap.set(id, {
          campaignId: id,
          chainId: opp.chainId ?? 0,
          whitelist: wl,
          blacklist: bl,
        });
      }
    });
  }

  // 补拉少量未在 opportunities.campaigns 出现的 campaign（兼容上游数据缺口）
  const missingCampaignIds = new Set<string>();
  for (const opp of liveOpportunities) {
    if (!opp.rewardsRecord?.breakdowns) continue;
    for (const breakdown of opp.rewardsRecord.breakdowns) {
      const id = String(breakdown.campaignId || '').trim();
      if (!id) continue;
      if (!campaignDetailsCache.has(id)) {
        missingCampaignIds.add(id);
      }
    }
  }

  if (missingCampaignIds.size > 0) {
    logger.info(`📦 Fetching ${missingCampaignIds.size} missing campaign details (fallback)...`);
    const campaignPromises = Array.from(missingCampaignIds).map(async (campaignId) => {
      const details = await fetchMerklCampaignDetails(campaignId);
      campaignDetailsCache.set(campaignId, details);
      return { campaignId, details };
    });
    await Promise.all(campaignPromises);
  }
  logger.info(`✅ Campaign details cache ready: ${campaignDetailsCache.size} items`);

  // Build forecast meta map early so breakdowns can be enriched with opportunity-only forecast data
  const forecastCampaignMetaLite = buildForecastCampaignMetaLiteMap(liveOpportunities);

  // 反查 Map: chainId:address → reserveId（用于从 opp 的 explorerAddress 反查对应 reserveId）
  // explorerAddress 可能是 underlying token、aToken、vToken 或 spoke 地址
  const tokenAddrToReserveId = new Map<string, string>();
  if (mergedOptions.baseDataset) {
    for (const r of mergedOptions.baseDataset) {
      const addMapping = (addr: string | undefined | null) => {
        if (!addr) return;
        const key = `${r.chainId}:${addr.toLowerCase()}`;
        if (!tokenAddrToReserveId.has(key)) {
          tokenAddrToReserveId.set(key, r.reserveId);
        }
      };
      addMapping(r.tokenAddress);
      addMapping(r.aTokenAddress);
      addMapping(r.vTokenAddress);
      addMapping(r.spokeAddress);
    }
  }

  // 处理所有 live opportunities（现在可以快速从缓存中获取数据）
  for (const opp of liveOpportunities) {
    if (!opp.explorerAddress) {
      const oppLink = generateMerklOpportunityLink(opp);
      logger.warn(`   ⚠️ No explorerAddress found for opportunity ${opp.id}${oppLink ? ` — ${oppLink}` : ''}`);
      continue;
    }
    
    // Derive protocol version from opportunity (ADR-0018 4-step priority)
    const protocolVersion = deriveProtocolVersion(
      opp.type,
      opp.explorerAddress,
      opp.chainId,
      protocolLookup.unambiguous,
      protocolLookup.v4Underlying,
    );
    const marketName = opp.chainId === 1 
      ? parseMarketNameFromOpportunityName(opp.name, opp.chainId)
      : 'Unknown';
    const explorerAddress = opp.explorerAddress.toLowerCase();
    
    // 生成 Merkl opportunity 链接（在 if-else 之前生成，以便在外部使用）
    const opportunityLink = generateMerklOpportunityLink(opp);
    
    if (!opportunityLink) {
      logger.warn(`   ⚠️ Could not generate link for opportunity ${opp.id}: missing identifier, type, or chain.name`);
    }
    
    const breakdowns: MerklCampaignBreakdown[] = [];
    const rewardsBreakdowns = opp.rewardsRecord?.breakdowns;
    if (!rewardsBreakdowns?.length) {
      continue;
    }

    for (const rewardBreakdown of rewardsBreakdowns) {
      const campaignId = String(rewardBreakdown.campaignId || '').trim();
      if (!campaignId) {
        logger.warn(`   ⚠️ Skipping breakdown without campaignId on opportunity ${opp.id}`);
        continue;
      }

      const campaignDetails = campaignDetailsCache.get(campaignId);
      if (!campaignDetails) {
        continue;
      }

      const useIntensity = merklBreakdownUsesPointsIntensityFields(rewardBreakdown);
      const pointsFields = useIntensity
        ? merklPointsFieldsFromBreakdownValue(opp, rewardBreakdown)
        : undefined;

      breakdowns.push({
        campaignApr: campaignDetails.apr,
        campaignStartedAt: campaignDetails.startedAt,
        campaignEndedAt: campaignDetails.endedAt,
        campaignId,
        whitelistOnly: campaignDetails.whitelistOnly,
        ...(pointsFields ?? {})
      });
    }

    const intensityCount = breakdowns.filter((b) => b.pointsPerThousandUsd !== undefined).length;
    if (intensityCount > 0) {
      const tvl = Number(opp.tvl) || 0;
      logger.info(
        `   📊 Opportunity ${opp.id}: ${intensityCount} breakdown(s) with reward-intensity fields, TVL: ${tvl}`
      );
    }

    // Enrich breakdowns with opportunity-only forecast fields
    for (const bd of breakdowns) {
      const meta = forecastCampaignMetaLite[bd.campaignId];
      if (meta) {
        const fields = await buildForecastFieldsFromOpportunity(meta, mergedOptions);
        if (fields) Object.assign(bd, fields);
      }
    }

    // 过滤已过期 campaign，每组仅保留最近一条过期
    const filteredBreakdowns = filterRecentExpiredCampaigns(breakdowns);

    // 记录过滤情况
    if (breakdowns.length > filteredBreakdowns.length) {
      const expiredCount = breakdowns.length - filteredBreakdowns.length;
      logger.info(`   🗑️ Filtered out ${expiredCount} expired campaign(s) for opportunity ${opp.id}`);
    }

    // 如果过滤后没有有效的 campaign，跳过这个 opportunity
    if (filteredBreakdowns.length === 0) {
      logger.info(`   ⏭️ Skipping opportunity ${opp.id}: all campaigns expired`);
      continue;
    }

    // 反查 opp 对应的 reserveId
    const oppReserveId = tokenAddrToReserveId.get(`${opp.chainId}:${explorerAddress}`);
    const reserveIdSet = mergedOptions.reserveIdSet ?? new Set<string>();

    const offsetTokenAddresses = oppReserveId
      ? extractOffsetTokenAddresses(opp, oppReserveId, reserveIdSet)
      : [];

    // 创建 opportunity 数据对象，根据 action 直接设置对应数组
    const opportunityData: MerklOpportunityData = {
      supply: opp.action === 'LEND' ? filteredBreakdowns : [],
      borrow: opp.action === 'BORROW' ? filteredBreakdowns : [],
      hold: opp.action === 'HOLD' ? filteredBreakdowns : [],
      marketName,
      chainId: opp.chainId,
      protocolVersion,
      ...(opportunityLink && { opportunityLink }),
      ...(opp.name && { name: opp.name }),
      ...(opp.description && { description: opp.description }),
      ...(opp.type && { opportunityType: opp.type }),
      ...(offsetTokenAddresses.length > 0 && { offsetTokenAddresses }),
    };
    
    // 创建索引键：chainId + explorerAddress（protocolVersion 在匹配时过滤，不需要在 key 中）
    const indexKey = `${opp.chainId}-${explorerAddress}`;
    
    if (!merklData[indexKey]) {
      merklData[indexKey] = [];
    }
    merklData[indexKey]!.push(opportunityData);
  }
  
  // 从索引中提取所有 opportunities 用于保存
  const processedData = Object.values(merklData).flat();
  
  logger.info(`✅ Processed ${processedData.length} Merkl opportunities`);
  logger.info(`📊 Created index with ${Object.keys(merklData).length} token keys`);
  logger.info(
    `📈 Merkl budget price source usage (non-PRETGE): snapshot=${priceSourceStats.snapshot}, reserve=${priceSourceStats.reserve}, coingecko=${priceSourceStats.coingecko}, missing=${priceSourceStats.missing}`
  );
  
  const freshTimestamp = new Date().toISOString();
  staleStatus = {
    ...staleStatus,
    stale: staleStatus.stale,
    fetchedOpportunities: fetchedOpportunities.length,
    usedOpportunities: liveOpportunities.length,
  };

  await persistMerklArtifacts({
    rawOpportunities: opportunities,
    liveOpportunities,
    processedData,
    index: merklData,
    forecastCampaignMetaLite,
    staleStatus,
  });

  if (!staleStatus.stale && Object.keys(merklData).length > 0) {
    _merklState.lastSuccessfulSnapshot = {
      rawOpportunities: opportunities,
      liveOpportunities,
      processedData,
      index: merklData,
      forecastCampaignMetaLite,
      lastSuccessfulAt: freshTimestamp,
    };
  }

  const campaignAccessArr = Array.from(campaignAccessMap.values());
  if (campaignAccessArr.length > 0) {
    logger.info(`📋 Campaign access: ${campaignAccessArr.length} campaigns with whitelist/blacklist data`);
  }

  return { index: merklData, campaignAccess: campaignAccessArr };
}

export function filterRecentExpiredCampaigns(breakdowns: MerklCampaignBreakdown[]): MerklCampaignBreakdown[] {
  const now = new Date();
  const active = breakdowns.filter(b =>
    !b.campaignEndedAt || new Date(b.campaignEndedAt) >= now
  );
  const expired = breakdowns.filter(b =>
    b.campaignEndedAt && new Date(b.campaignEndedAt) < now
  );
  const byType = new Map<string, MerklCampaignBreakdown>();
  for (const b of expired) {
    const type = b.campaignType ?? 'UNKNOWN';
    const existing = byType.get(type);
    if (!existing || new Date(b.campaignEndedAt!) > new Date(existing.campaignEndedAt!)) {
      byType.set(type, b);
    }
  }
  return [...active, ...byType.values()];
}

function extractOffsetTokenAddresses(
  opp: MerklOpportunity,
  oppReserveId: string,
  reserveIdSet: Set<string>,
): OffsetTokenInfo[] {
  if (!Array.isArray(opp.campaigns)) return [];
  const seen = new Set<string>();
  const rawAddrs: string[] = [];
  for (const campaign of opp.campaigns) {
    const tokens: unknown = campaign?.params?.tokens;
    if (Array.isArray(tokens)) {
      for (const t of tokens) {
        const addr = typeof t === 'string'
          ? t.toLowerCase()
          : (typeof t === 'object' && t !== null && typeof (t as any).underlyingToken === 'string')
            ? (t as any).underlyingToken.toLowerCase()
            : null;
        if (addr && !seen.has(addr)) {
          seen.add(addr);
          rawAddrs.push(addr);
        }
      }
    }
  }
  return rawAddrs.map(addr => {
    const resolvedIds = resolveOffsetReserveIds(oppReserveId, addr, reserveIdSet);
    if (resolvedIds.length === 1) return { address: addr, reserveId: resolvedIds[0] };
    return { address: addr };
  });
}

export function detectNetPositionByHeuristic(
  opp: MerklOpportunityData,
  oppReserveId: string,
  reserveIdSet: Set<string>,
  symbolLookup: Map<string, string>,
): NetPositionConstraint | null {
  const text = `${opp.name ?? ''} ${opp.description ?? ''}`.toLowerCase();
  const netIndicators = ['net lend', 'net borrow', 'net supply', 'net position', 'excluding borrower', 'excluding supplier', 'excluding lender', 'minus borrow', 'minus supply', 'net usde', 'net gho', 'net eth', 'net usdc', 'net usdt', 'net dai', 'net wbtc', 'net weeth'];
  const isNet = netIndicators.some(kw => text.includes(kw));
  if (!isNet) return null;

  const type = opp.opportunityType?.toLowerCase() ?? '';
  const sourceSide: 'supply' | 'borrow' = type.includes('borrow') || text.includes('net borrow') ? 'borrow' : 'supply';

  const offsetReserveIds: string[] = [];
  const seen = new Set<string>();
  if (seen.add(oppReserveId)) {
    // source token is always an offset in net positions
  }
  for (const ota of (opp.offsetTokenAddresses ?? [])) {
    const resolvedIds = resolveOffsetReserveIds(oppReserveId, ota.address.toLowerCase(), reserveIdSet);
    for (const rid of resolvedIds) {
      if (!seen.has(rid)) {
        seen.add(rid);
        offsetReserveIds.push(rid);
      }
    }
  }
  if (offsetReserveIds.length === 0) {
    const selfRid = reserveIdSet.has(oppReserveId) ? oppReserveId : null;
    if (selfRid) offsetReserveIds.push(selfRid);
  }
  if (offsetReserveIds.length === 0) return null;

  return { sourceSide, offsetReserveIds };
}

export async function detectNetPositionConstraint(
  opp: MerklOpportunityData,
  sourceTokenAddress: string,
  oppReserveId: string,
  reserveIdSet: Set<string>,
  symbolLookup: Map<string, string>,
  cachedConstraint?: NetPositionConstraint | null,
  llmFn?: () => Promise<import('./merklLlmClient.js').LlmAnalysisResult | null>,
): Promise<NetPositionConstraint | null> {
  const layer1 = extractNetPositionConstraint(opp, sourceTokenAddress, oppReserveId, reserveIdSet);
  if (layer1) return layer1;

  if (cachedConstraint) return cachedConstraint;

  if (llmFn) {
    const llmResult = await llmFn();
    if (llmResult) {
      const { sourceSide, offsetTokenSymbols } = llmResult;
      if (offsetTokenSymbols && offsetTokenSymbols.length > 0) {
        const offsetReserveIds: string[] = [];
        const seen = new Set<string>();
        for (const symbol of offsetTokenSymbols) {
          const tokenAddr = symbolLookup.get(`${opp.chainId}:${symbol}`);
          if (!tokenAddr) return detectNetPositionByHeuristic(opp, oppReserveId, reserveIdSet, symbolLookup);
          const resolvedIds = resolveOffsetReserveIds(oppReserveId, tokenAddr.toLowerCase(), reserveIdSet);
          if (resolvedIds.length === 0) return detectNetPositionByHeuristic(opp, oppReserveId, reserveIdSet, symbolLookup);
          for (const rid of resolvedIds) {
            if (!seen.has(rid)) {
              seen.add(rid);
              offsetReserveIds.push(rid);
            }
          }
        }
        if (offsetReserveIds.length > 0) return { sourceSide, offsetReserveIds };
      }
    }
  }

  return detectNetPositionByHeuristic(opp, oppReserveId, reserveIdSet, symbolLookup);
}

export function extractNetPositionConstraint(
  opp: MerklOpportunityData,
  sourceTokenAddress: string,
  oppReserveId: string,
  reserveIdSet: Set<string>,
): NetPositionConstraint | null {
  const type = opp.opportunityType;
  if (!type || !type.startsWith('AAVE_NET_')) return null;

  const sourceSide: 'supply' | 'borrow' = type === 'AAVE_NET_BORROWING' ? 'borrow' : 'supply';

  const sourceAddrLower = sourceTokenAddress.toLowerCase();
  const isNetType = type === 'AAVE_NET_LENDING' || type === 'AAVE_NET_BORROWING';
  const offsetReserveIds: string[] = [];
  const seen = new Set<string>();

  const debugMissing: string[] = [];

  for (const info of (opp.offsetTokenAddresses ?? [])) {
    if (!isNetType && info.address.toLowerCase() === sourceAddrLower) continue;
    if (info.reserveId && !seen.has(info.reserveId)) {
      seen.add(info.reserveId);
      offsetReserveIds.push(info.reserveId);
    } else if (!info.reserveId) {
      const resolvedIds = resolveOffsetReserveIds(oppReserveId, info.address.toLowerCase(), reserveIdSet);
      for (const rid of resolvedIds) {
        if (!seen.has(rid)) {
          seen.add(rid);
          offsetReserveIds.push(rid);
        }
      }
      if (resolvedIds.length === 0) {
        debugMissing.push(info.address.toLowerCase());
      }
    }
  }

  if (offsetReserveIds.length === 0) {
    logger.warn(`⚠️ extractNetPositionConstraint: no offsetReserveIds for opp "${opp.name}" type=${type} chain=${opp.chainId} sourceToken=${sourceAddrLower} offsetAddrs=${JSON.stringify(opp.offsetTokenAddresses)} missingAddrs=${JSON.stringify(debugMissing)} reserveIdSetSize=${reserveIdSet.size}`);
    return null;
  }

  return { sourceSide, offsetReserveIds };
}

/**
 * 根据 token 地址查找匹配的 Merkl opportunities，按 protocol version 过滤。
 * V3 reserve 只匹配 V3 opportunities，V4 reserve 只匹配 V4 opportunities。
 */
export function findMatchingMerklOpportunities(
  item: {
    chainId: number;
    marketName: string;
    tokenAddress: string;
    aTokenAddress?: string | null;
    vTokenAddress?: string | null;
  },
  merklData: Record<string, MerklOpportunityData[]>,
  protocolVersion: 'v3' | 'v4',
): MerklOpportunityData[] {
  const matchedOpportunities: MerklOpportunityData[] = [];
  const seenOpportunities = new Set<MerklOpportunityData>();
  
  // 构建要检查的 token 地址列表（按优先级：underlying → aToken → vToken）
  const tokenAddressesToCheck: string[] = [
    item.tokenAddress.toLowerCase(),
    item.aTokenAddress?.toLowerCase(),
    item.vTokenAddress?.toLowerCase()
  ].filter((addr): addr is string => addr !== null && addr !== undefined);
  
  // 检查每个地址是否在索引中
  for (const tokenAddr of tokenAddressesToCheck) {
    const indexKey = `${item.chainId}-${tokenAddr}`;
    
    const matchingOpportunities = merklData[indexKey];
    if (matchingOpportunities?.length > 0) {
      for (const opp of matchingOpportunities) {
        if (!seenOpportunities.has(opp) && opp.protocolVersion === protocolVersion) {
          seenOpportunities.add(opp);
          matchedOpportunities.push(opp);
        }
      }
    }
  }
  
  return matchedOpportunities;
}

/**
 * 格式化 Merkl campaign breakdown 为字符串（用于 CSV）
 * 字段顺序：campaignApr, campaignStartedAt, campaignEndedAt, campaignId
 * 
 * 按 opportunity 分组显示，每个 opportunity 的 breakdowns 后跟其对应的链接
 * 格式：breakdown1; breakdown2, link1; breakdown3; breakdown4, link2
 * 
 * @param breakdowns Merkl campaign breakdowns 数组（用于 CSV 时，每个 breakdown 可能包含 opportunityLink 属性）
 */
export function formatMerklBreakdown(breakdowns: Array<MerklCampaignBreakdown & { opportunityLink?: string }>): string {
  if (breakdowns.length === 0) {
    return '';
  }
  
  // 按 opportunityLink 分组
  const groupedByLink = new Map<string, Array<MerklCampaignBreakdown & { opportunityLink?: string }>>();
  const noLinkBreakdowns: Array<MerklCampaignBreakdown & { opportunityLink?: string }> = [];
  
  for (const b of breakdowns) {
    if (b.opportunityLink) {
      if (!groupedByLink.has(b.opportunityLink)) {
        groupedByLink.set(b.opportunityLink, []);
      }
      groupedByLink.get(b.opportunityLink)!.push(b);
    } else {
      noLinkBreakdowns.push(b);
    }
  }
  
  // 格式化每个分组的 breakdowns
  const formatBreakdown = (b: MerklCampaignBreakdown): string => {
    let startDate = 'N/A';
    if (b.campaignStartedAt) {
      const date = new Date(b.campaignStartedAt);
      startDate = date.toLocaleString('en-US', { 
        year: 'numeric', 
        month: '2-digit', 
        day: '2-digit', 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true
      });
    }
    let endDate = 'N/A';
    if (b.campaignEndedAt) {
      const date = new Date(b.campaignEndedAt);
      endDate = date.toLocaleString('en-US', { 
        year: 'numeric', 
        month: '2-digit', 
        day: '2-digit', 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true
      });
    }
    return `${b.campaignApr * 100}% (${startDate} - ${endDate}, ${b.campaignId})`;
  };
  
  // 构建分组后的字符串
  const parts: string[] = [];
  
  // 处理有链接的分组：每个分组的 breakdowns 后跟其链接
  for (const [link, groupBreakdowns] of groupedByLink.entries()) {
    const breakdownsStr = groupBreakdowns.map(formatBreakdown).join('; ');
    parts.push(`${breakdownsStr}, ${link}`);
  }
  
  // 处理没有链接的 breakdowns
  if (noLinkBreakdowns.length > 0) {
    parts.push(noLinkBreakdowns.map(formatBreakdown).join('; '));
  }
  
  return parts.join('; ');
}
