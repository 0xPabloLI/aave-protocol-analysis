import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../logger.js';
import { BACKEND_CACHE_TTL_MS, MERKL_TTL } from '../cacheTtl.js';
import { merklFetchConfig } from '../config.js';
import {
  createMerklConcurrencyLimitedFetch,
  normalizeMerklCampaignTotalBudget,
} from '@internal/aave-shared-config';
import { fifoEvict } from '@internal/aave-shared-contracts';
import {
  buildForecastState,
  normalizeCampaignType,
  type CampaignForecastType,
  type MerklForecastState,
} from './merklForecastModel.js';
import { fetchMerklOpportunities } from './merklOpportunityClient.js';

const MERKL_BASE_URL = 'https://api.merkl.xyz/v4';
/** Shared with opportunities + root fetcher: `MERKL_FETCH_MAX_CONCURRENCY` in `aave-shared-config`. */
const merklLimitedFetch = createMerklConcurrencyLimitedFetch(fetch);
const SECONDS_PER_DAY = 86400;
const MERKL_LITE_FILE_MAX_AGE_MS = BACKEND_CACHE_TTL_MS.merklLiteFileMaxAge;
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data');
const RUNTIME_DATA_DIR = join(DATA_DIR, 'runtime');
const DEBUG_DATA_DIR = join(DATA_DIR, 'debug');
const MERKL_DEBUG_DATA_DIR = join(DEBUG_DATA_DIR, 'merkl');
const MERKL_METRICS_DEBUG_DIR = join(MERKL_DEBUG_DATA_DIR, 'metrics');
const MERKL_CAMPAIGN_DEBUG_DIR = join(MERKL_DEBUG_DATA_DIR, 'campaigns');
const MERKL_OPPORTUNITY_META_LITE_PATH = join(RUNTIME_DATA_DIR, 'merkl-opportunity-meta-lite.json');
const LEGACY_MERKL_OPPORTUNITY_META_LITE_PATH = join(DATA_DIR, 'merkl-opportunity-meta-lite.json');

export const FORECAST_SOFT_TTL_MS = MERKL_TTL.forecastResultSoftTtlMs;

const OPPORTUNITY_META_SOFT_TTL_MS = MERKL_TTL.forecastOpportunityMetaSoftTtlMs;

const OPPORTUNITY_META_HARD_TTL_MS = MERKL_TTL.forecastOpportunityMetaHardTtlMs;

const METRICS_SOFT_TTL_MS = MERKL_TTL.metricsSoftTtlMs;

const METRICS_CACHE_MIN_TTL_MS = BACKEND_CACHE_TTL_MS.merklMetricsMin;
const METRICS_CACHE_MAX_TTL_MS = BACKEND_CACHE_TTL_MS.merklMetricsMax;
const METRICS_CACHE_EMPTY_TTL_MS = BACKEND_CACHE_TTL_MS.merklMetricsEmpty;
const METRICS_CACHE_HARD_TTL_MS = MERKL_TTL.metricsHardTtlMs;

interface MetricsCacheEntry {
  data: ForecastMetricsLite;
  expiresAt: number;
  updatedAt: number;
}

interface CampaignOpportunityMeta {
  tvl: number;
  campaignTypeHint: CampaignForecastType;
  campaignSnapshot: CampaignSnapshotLite | null;
  useTokenRateInMetrics: boolean;
}

interface CampaignOpportunityCacheEntry {
  data: Map<string, CampaignOpportunityMeta>;
  expiresAt: number;
  updatedAt: number;
}

// metricsCache has dynamic TTL (10m-6h based on data cadence) to avoid unnecessary Merkl API calls.
// forecastCache was removed because with cron-write pattern (every 10m), it provided no benefit.
// Forecast computation is fast; metrics fetching is the expensive operation.
const inFlight = new Map<string, Promise<MerklForecastState>>();
const metricsCache = new Map<string, MetricsCacheEntry>();
let campaignOpportunityCache: CampaignOpportunityCacheEntry | null = null;
const zeroBaselineFirstSeenAt = new Map<string, number>();

const MAX_METRICS_CACHE_ENTRIES = 500;
const MAX_ZERO_BASELINE_CACHE_ENTRIES = 500;

function pruneMetricsCache(now: number): void {
  for (const [key, entry] of metricsCache.entries()) {
    if (entry.expiresAt <= now) {
      metricsCache.delete(key);
    }
  }
  fifoEvict(metricsCache, MAX_METRICS_CACHE_ENTRIES);
}

function pruneZeroBaselineCache(): void {
  fifoEvict(zeroBaselineFirstSeenAt, MAX_ZERO_BASELINE_CACHE_ENTRIES);
}

interface CampaignSnapshotLite {
  id: string;
  amount?: unknown;
  startTimestamp?: unknown;
  endTimestamp?: unknown;
  rewardToken?: {
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

interface MerklOpportunityMetaLiteFile {
  timestamp?: unknown;
  campaigns?: unknown;
}

interface ForecastMetricsLite {
  tvlRecords?: Array<{ timestamp?: unknown; total?: unknown }>;
  dailyRewardsRecords?: Array<{ timestamp?: unknown; total?: unknown; totalInToken?: unknown }>;
}

const persistMerklDebugSnapshot = async (params: {
  campaignId: string;
  campaign?: unknown;
  metrics: unknown;
}): Promise<void> => {
  try {
    await mkdir(MERKL_METRICS_DEBUG_DIR, { recursive: true });
    await mkdir(MERKL_CAMPAIGN_DEBUG_DIR, { recursive: true });

    const fetchedAt = new Date().toISOString();
    await writeFile(
      join(MERKL_METRICS_DEBUG_DIR, `${params.campaignId}.json`),
      JSON.stringify(
        {
          fetchedAt,
          campaignId: params.campaignId,
          metrics: params.metrics,
        },
        null,
        2
      ),
      'utf-8'
    );

    if (params.campaign !== undefined) {
      await writeFile(
        join(MERKL_CAMPAIGN_DEBUG_DIR, `${params.campaignId}.json`),
        JSON.stringify(
          {
            fetchedAt,
            campaignId: params.campaignId,
            campaign: params.campaign,
          },
          null,
          2
        ),
        'utf-8'
      );
    }
  } catch (error) {
    logger.warn(
      `⚠️ Failed to persist Merkl debug snapshot for ${params.campaignId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

type TimeSeriesPoint = {
  timestamp: number;
  total: number;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const getAtPath = (obj: unknown, path: string[]): unknown => {
  let current: unknown = obj;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
};

const extractMaxApr = (campaign: unknown): number | null => {
  const directCandidates: Array<string[]> = [
    ['params', 'distributionMethodParameters', 'distributionSettings', 'apr'],
    ['distributionMethodParameters', 'distributionSettings', 'apr'],
    ['distributionSettings', 'apr'],
  ];

  for (const path of directCandidates) {
    const value = toNumber(getAtPath(campaign, path));
    if (value !== null && value > 0) return value;
  }

  return null;
};

const buildCampaignSnapshotLite = (campaign: unknown): CampaignSnapshotLite | null => {
  const id = getAtPath(campaign, ['id']);
  if (typeof id !== 'string' || !id) return null;

  const amount = getAtPath(campaign, ['amount']);
  const startTimestamp = getAtPath(campaign, ['startTimestamp']);
  const endTimestamp = getAtPath(campaign, ['endTimestamp']);
  const rewardTokenPrice = getAtPath(campaign, ['rewardToken', 'price']);
  const rewardTokenDecimals = getAtPath(campaign, ['rewardToken', 'decimals']);
  const apr = getAtPath(campaign, ['params', 'distributionMethodParameters', 'distributionSettings', 'apr']);
  const decimalsRewardToken = getAtPath(campaign, ['params', 'decimalsRewardToken']);

  const snapshot: CampaignSnapshotLite = { id };

  if (amount !== undefined) snapshot.amount = amount;
  if (startTimestamp !== undefined) snapshot.startTimestamp = startTimestamp;
  if (endTimestamp !== undefined) snapshot.endTimestamp = endTimestamp;
  if (rewardTokenPrice !== undefined || rewardTokenDecimals !== undefined) {
    snapshot.rewardToken = {
      ...(rewardTokenPrice !== undefined ? { price: rewardTokenPrice } : {}),
      ...(rewardTokenDecimals !== undefined ? { decimals: rewardTokenDecimals } : {}),
    };
  }
  if (apr !== undefined || decimalsRewardToken !== undefined) {
    snapshot.params = {
      ...(decimalsRewardToken !== undefined ? { decimalsRewardToken } : {}),
      ...(apr !== undefined
        ? { distributionMethodParameters: { distributionSettings: { apr } } }
        : {}),
    };
  }

  return snapshot;
};

const canComputeForecastFromSnapshot = (campaign: CampaignSnapshotLite): boolean =>
  toNumber(campaign.amount) !== null &&
  toNumber(campaign.startTimestamp) !== null &&
  toNumber(campaign.endTimestamp) !== null;

const extractLatestTvl = (metrics: unknown): number => {
  const tvl = getAtPath(metrics, ['tvlRecords']);
  if (Array.isArray(tvl) && tvl.length > 0) {
    const sorted = [...tvl].sort((a, b) => {
      const ta = toNumber(getAtPath(a, ['timestamp'])) || 0;
      const tb = toNumber(getAtPath(b, ['timestamp'])) || 0;
      return ta - tb;
    });
    const last = sorted[sorted.length - 1];
    const lastTotal = toNumber(getAtPath(last, ['total']));
    if (lastTotal !== null && lastTotal >= 0) return lastTotal;
  }
  return 0;
};

export const extractDailyRewardsRecords = (
  metrics: unknown,
  useTokenRateInMetrics = false
): TimeSeriesPoint[] => {
  const raw = getAtPath(metrics, ['dailyRewardsRecords']);
  if (!Array.isArray(raw)) return [];

  return raw
    .map((entry) => ({
      timestamp: toNumber(getAtPath(entry, ['timestamp'])) || 0,
      total:
        (useTokenRateInMetrics
          ? toNumber(getAtPath(entry, ['totalInToken'])) ?? toNumber(getAtPath(entry, ['total']))
          : toNumber(getAtPath(entry, ['total'])) ?? toNumber(getAtPath(entry, ['totalInToken']))) || 0,
    }))
    .filter((entry) => entry.timestamp > 0 && entry.total >= 0)
    .sort((a, b) => a.timestamp - b.timestamp);
};

const extractMetricsCadenceSeconds = (metrics: unknown): number | null => {
  const diffs: number[] = [];
  const raw = getAtPath(metrics, ['dailyRewardsRecords']);
  if (Array.isArray(raw)) {
    const timestamps = raw
      .map((entry) => toNumber(getAtPath(entry, ['timestamp'])) || 0)
      .filter((ts) => ts > 0)
      .sort((a, b) => a - b);

    for (let i = 1; i < timestamps.length; i += 1) {
      const diff = timestamps[i] - timestamps[i - 1];
      if (diff > 0) diffs.push(diff);
    }
  }

  if (diffs.length === 0) return null;
  diffs.sort((a, b) => a - b);
  const mid = Math.floor(diffs.length / 2);
  const median =
    diffs.length % 2 === 0 ? (diffs[mid - 1] + diffs[mid]) / 2 : diffs[mid];
  return Number.isFinite(median) && median > 0 ? median : null;
};

const deriveMetricsCacheTtlMs = (metrics: unknown): { ttlMs: number; cadenceSeconds: number | null } => {
  const cadenceSeconds = extractMetricsCadenceSeconds(metrics);
  if (cadenceSeconds === null) {
    return { ttlMs: METRICS_CACHE_EMPTY_TTL_MS, cadenceSeconds: null };
  }

  // Use an aggressive fraction of observed cadence (user-approved), capped for safety.
  const candidateMs = Math.floor((cadenceSeconds * 1000) / 4);
  const ttlMs = clamp(
    candidateMs || METRICS_SOFT_TTL_MS,
    METRICS_CACHE_MIN_TTL_MS,
    METRICS_CACHE_MAX_TTL_MS
  );
  return { ttlMs, cadenceSeconds };
};

const trimMetricsForForecast = (metrics: unknown): ForecastMetricsLite => {
  const rawTvl = getAtPath(metrics, ['tvlRecords']);
  const tvlRecords = Array.isArray(rawTvl)
    ? (rawTvl as Array<{ timestamp?: unknown; total?: unknown }>)
    : [];
  const latestTvlRecord =
    tvlRecords.length > 0
      ? [...tvlRecords].sort((a, b) => {
          const ta = toNumber(getAtPath(a, ['timestamp'])) || 0;
          const tb = toNumber(getAtPath(b, ['timestamp'])) || 0;
          return ta - tb;
        })[tvlRecords.length - 1]
      : null;

  return {
    tvlRecords: latestTvlRecord ? [latestTvlRecord] : [],
    dailyRewardsRecords: Array.isArray(getAtPath(metrics, ['dailyRewardsRecords']))
      ? (getAtPath(metrics, ['dailyRewardsRecords']) as Array<{
          timestamp?: unknown;
          total?: unknown;
          totalInToken?: unknown;
        }>)
      : [],
  };
};

const hasForecastableMetrics = (metrics: ForecastMetricsLite): boolean =>
  Array.isArray(metrics.dailyRewardsRecords) && metrics.dailyRewardsRecords.length > 0;

const campaignUsesTokenRateInMetrics = (breakdown: unknown): boolean =>
  String(getAtPath(breakdown, ['token', 'type']) || '').trim().toUpperCase() === 'PRETGE';

const estimateDistributedSoFar = (
  dailyRewardsRecords: TimeSeriesPoint[],
  startTs: number,
  endTs: number,
  nowTs: number
): number => {
  const effectiveEnd = Math.max(Math.min(nowTs, endTs), startTs);
  if (effectiveEnd <= startTs) return 0;
  if (dailyRewardsRecords.length === 0) return 0;

  const findRateAt = (ts: number): number => {
    let candidate = dailyRewardsRecords[0].total;
    for (const point of dailyRewardsRecords) {
      if (point.timestamp <= ts) {
        candidate = point.total;
      } else {
        break;
      }
    }
    return candidate;
  };

  let distributed = 0;
  let cursor = startTs;
  let currentRate = findRateAt(startTs);

  for (const point of dailyRewardsRecords) {
    if (point.timestamp <= startTs) continue;
    if (point.timestamp >= effectiveEnd) break;

    const segmentSeconds = point.timestamp - cursor;
    if (segmentSeconds > 0) {
      distributed += currentRate * (segmentSeconds / SECONDS_PER_DAY);
    }
    cursor = point.timestamp;
    currentRate = point.total;
  }

  if (effectiveEnd > cursor) {
    distributed += currentRate * ((effectiveEnd - cursor) / SECONDS_PER_DAY);
  }

  return Math.max(distributed, 0);
};

const isTransientError = (error: unknown): boolean => {
  if (error instanceof TypeError && error.message === 'fetch failed') {
    const cause = (error as { cause?: { code?: string } }).cause;
    return cause?.code === 'ECONNRESET' || cause?.code === 'ETIMEDOUT' || cause?.code === 'UND_ERR_SOCKET';
  }
  return false;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const fetchJson = async (url: string): Promise<unknown> => {
  for (let attempt = 0; attempt <= merklFetchConfig.maxRetries; attempt++) {
    try {
      const response = await merklLimitedFetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`Merkl API ${response.status} for ${url}`);
      }
      if (!response.ok) {
        throw new Error(`Merkl API ${response.status} for ${url}`);
      }
      return response.json() as Promise<unknown>;
    } catch (error) {
      const retryable =
        isTransientError(error) ||
        (error instanceof Error && /Merkl API (429|5\d\d)/.test(error.message));
      if (!retryable || attempt >= merklFetchConfig.maxRetries) throw error;
      const delay = Math.min(
        merklFetchConfig.baseDelayMs * Math.pow(2, attempt),
        merklFetchConfig.maxDelayMs
      );
      logger.warn(`⏳ Merkl fetch retry ${attempt + 1}/${merklFetchConfig.maxRetries} for ${url} in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw new Error(`Merkl fetch exhausted retries for ${url}`);
};

const getFreshCampaignMetaMapFromLiteFile = async (): Promise<Map<string, CampaignOpportunityMeta> | null> => {
  try {
    let fileContent: string;
    try {
      fileContent = await readFile(MERKL_OPPORTUNITY_META_LITE_PATH, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      fileContent = await readFile(LEGACY_MERKL_OPPORTUNITY_META_LITE_PATH, 'utf-8');
      logger.warn(`📦 Merkl forecast using legacy lite snapshot path fallback: ${LEGACY_MERKL_OPPORTUNITY_META_LITE_PATH}`);
    }
    const parsed = JSON.parse(fileContent) as MerklOpportunityMetaLiteFile;
    const tsRaw = parsed?.timestamp;
    const tsMs = typeof tsRaw === 'string' ? Date.parse(tsRaw) : NaN;
    if (!Number.isFinite(tsMs)) return null;
    if (Date.now() - tsMs > MERKL_LITE_FILE_MAX_AGE_MS) return null;

    const campaigns = parsed?.campaigns;
    if (!campaigns || typeof campaigns !== 'object') return null;

    const map = new Map<string, CampaignOpportunityMeta>();
    for (const [campaignId, value] of Object.entries(campaigns as Record<string, unknown>)) {
      if (!campaignId || !value || typeof value !== 'object') continue;
      const tvl = toNumber(getAtPath(value, ['tvl']));
      if (tvl === null || tvl < 0) continue;

      const rawDistributionType = getAtPath(value, ['rawDistributionType']);
      const rawDistributionMethod = getAtPath(value, ['rawDistributionMethod']);
      const rawMode = getAtPath(value, ['rawMode']);
      const campaignTypeHint = normalizeCampaignType({
        distributionType: typeof rawDistributionType === 'string' ? rawDistributionType : undefined,
        distributionMethod: typeof rawDistributionMethod === 'string' ? rawDistributionMethod : undefined,
        mode: typeof rawMode === 'string' ? rawMode : undefined,
      });
      if (!campaignTypeHint) continue;

      const campaignSnapshotRaw = getAtPath(value, ['campaignSnapshot']);
      const campaignSnapshot =
        campaignSnapshotRaw && typeof campaignSnapshotRaw === 'object'
          ? (campaignSnapshotRaw as CampaignSnapshotLite)
          : null;

      map.set(campaignId, {
        tvl,
        campaignTypeHint,
        campaignSnapshot,
        useTokenRateInMetrics: Boolean(getAtPath(value, ['useTokenRateInMetrics'])),
      });
    }

    return map.size > 0 ? map : null;
  } catch {
    return null;
  }
};

export const buildCampaignOpportunityMetaMapFromOpportunities = (
  allOpps: unknown[]
): Map<string, CampaignOpportunityMeta> => {
  const map = new Map<string, CampaignOpportunityMeta>();
  allOpps.forEach((opp) => {
    const tvl = toNumber(getAtPath(opp, ['tvl']));
    if (tvl === null || tvl < 0) return;
    const oppDistributionTypeRaw = getAtPath(opp, ['distributionType']);
    const breakdowns = getAtPath(opp, ['rewardsRecord', 'breakdowns']);
    if (!Array.isArray(breakdowns)) return;
    const oppCampaignsRaw = getAtPath(opp, ['campaigns']);
    const oppCampaigns = Array.isArray(oppCampaignsRaw) ? oppCampaignsRaw : [];
    const campaignSnapshotById = new Map<string, CampaignSnapshotLite>();
    oppCampaigns.forEach((campaign) => {
      const snapshotLite = buildCampaignSnapshotLite(campaign);
      if (snapshotLite) {
        campaignSnapshotById.set(snapshotLite.id, snapshotLite);
      }
    });

    breakdowns.forEach((breakdown) => {
      const campaignId = getAtPath(breakdown, ['campaignId']);
      if (typeof campaignId !== 'string' || !campaignId) return;
      const campaignSnapshot = campaignSnapshotById.get(campaignId) ?? null;
      const useTokenRateInMetrics = campaignUsesTokenRateInMetrics(breakdown);

      const breakdownDistributionType =
        (typeof getAtPath(breakdown, ['distributionType']) === 'string' && getAtPath(breakdown, ['distributionType'])) ||
        (typeof oppDistributionTypeRaw === 'string' && oppDistributionTypeRaw) ||
        undefined;
      const breakdownDistributionMethod =
        (typeof getAtPath(breakdown, ['distributionMethod']) === 'string' && getAtPath(breakdown, ['distributionMethod'])) ||
        undefined;
      const matchingCampaign = oppCampaigns.find(
        (c: any) => String(getAtPath(c, ['id']) || '') === campaignId
      );
      const mode =
        getAtPath(matchingCampaign, ['params', 'distributionMethodParameters', 'distributionSettings', 'mode']) ||
        undefined;

      const hintType = normalizeCampaignType({
        distributionType: breakdownDistributionType,
        distributionMethod: breakdownDistributionMethod,
        mode,
      });
      if (!hintType) return;

      const previous = map.get(campaignId);
      if (!previous) {
        map.set(campaignId, {
          tvl,
          campaignTypeHint: hintType,
          campaignSnapshot,
          useTokenRateInMetrics,
        });
        return;
      }

      map.set(campaignId, {
        tvl: previous.tvl > 0 ? previous.tvl : tvl,
        campaignTypeHint: previous.campaignTypeHint,
        campaignSnapshot: previous.campaignSnapshot ?? campaignSnapshot,
        useTokenRateInMetrics: previous.useTokenRateInMetrics || useTokenRateInMetrics,
      });
    });
  });
  return map;
};

const getCachedOrFetchMetrics = async (
  campaignId: string
): Promise<{ raw: unknown; data: ForecastMetricsLite }> => {
  const now = Date.now();
  const cached = metricsCache.get(campaignId);
  if (cached && cached.expiresAt > now) {
    return { raw: null, data: cached.data };
  }

  const previous = cached;
  const canUsePreviousFallback = (): boolean => {
    if (!previous || !hasForecastableMetrics(previous.data)) return false;
    return Math.max(0, Date.now() - previous.updatedAt) <= METRICS_CACHE_HARD_TTL_MS;
  };

  const rawMetrics = await fetchJson(`${MERKL_BASE_URL}/campaigns/${campaignId}/metrics`);
  const { ttlMs } = deriveMetricsCacheTtlMs(rawMetrics);
  const metrics = trimMetricsForForecast(rawMetrics);

  if (!hasForecastableMetrics(metrics)) {
    if (canUsePreviousFallback()) {
      logger.warn(
        `⚠️ Merkl metrics refresh returned empty for ${campaignId}; keeping previous cache (age=${Math.round(
          (Date.now() - previous!.updatedAt) / 1000
        )}s, max=${Math.round(METRICS_CACHE_HARD_TTL_MS / 1000)}s)`
      );
      return { raw: null, data: previous!.data };
    }

    logger.warn(
      `⚠️ Merkl metrics returned empty dailyRewardsRecords for ${campaignId}; using zero-distributed baseline`
    );
  }

  metricsCache.set(campaignId, {
    data: metrics,
    expiresAt: now + ttlMs,
    updatedAt: now,
  });
  pruneMetricsCache(now);
  return { raw: rawMetrics, data: metrics };
};

const getCampaignOpportunityMetaMap = async (): Promise<Map<string, CampaignOpportunityMeta>> => {
  const now = Date.now();
  if (campaignOpportunityCache && campaignOpportunityCache.expiresAt > now) {
    return campaignOpportunityCache.data;
  }

  const previousEntry = campaignOpportunityCache;
  const previous = previousEntry?.data;

  const canUsePreviousFallback = (): boolean => {
    if (!previousEntry || !previous || previous.size === 0) return false;
    const ageMs = Math.max(0, Date.now() - previousEntry.updatedAt);
    return ageMs <= OPPORTUNITY_META_HARD_TTL_MS;
  };

  const cacheAndReturn = (
    map: Map<string, CampaignOpportunityMeta>,
    updatedAt: number = Date.now()
  ): Map<string, CampaignOpportunityMeta> => {
    campaignOpportunityCache = {
      data: map,
      expiresAt: Date.now() + OPPORTUNITY_META_SOFT_TTL_MS,
      updatedAt,
    };
    return map;
  };

  try {
    let map = await getFreshCampaignMetaMapFromLiteFile();
    if (map) {
      logger.info('📦 Merkl forecast using fresh merkl-opportunity-meta-lite.json');
      if (map.size > 0) {
        return cacheAndReturn(map);
      }
      if (canUsePreviousFallback()) {
        logger.warn('⚠️ Merkl forecast lite map is empty; keeping previous campaign opportunity cache');
        return cacheAndReturn(previous!, previousEntry!.updatedAt);
      }
      if (previous && previous.size > 0) {
        logger.warn('⚠️ Merkl forecast lite map is empty and previous cache is too stale; refusing fallback');
      }
    }

    const allOpps = await fetchMerklOpportunities();
    map = buildCampaignOpportunityMetaMapFromOpportunities(allOpps);

    if (map.size === 0 && canUsePreviousFallback()) {
      logger.warn('⚠️ Merkl opportunities fallback map is empty; keeping previous campaign opportunity cache');
      return cacheAndReturn(previous!, previousEntry!.updatedAt);
    }
    if (map.size === 0 && previous && previous.size > 0) {
      logger.warn('⚠️ Merkl opportunities fallback map is empty and previous cache is too stale; refusing fallback');
    }

    return cacheAndReturn(map);
  } catch (error) {
    if (canUsePreviousFallback()) {
      logger.warn(
        `⚠️ Failed to refresh campaign opportunity cache, using previous snapshot: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return cacheAndReturn(previous!, previousEntry!.updatedAt);
    }
    if (previous && previous.size > 0) {
      logger.warn(
        `⚠️ Failed to refresh campaign opportunity cache and previous snapshot is too stale (max ${Math.round(
          OPPORTUNITY_META_HARD_TTL_MS / 1000
        )}s): ${error instanceof Error ? error.message : String(error)}`
      );
    }
    throw error;
  }
};

export const extractNormalizedTotalBudget = (campaign: unknown, campaignId: string): number => {
  const totalBudget = normalizeMerklCampaignTotalBudget(campaign);
  if (totalBudget === null) {
    throw new Error(`Missing campaign budget for campaign ${campaignId}`);
  }
  return totalBudget;
};

export const getMerklForecastState = async (campaignId: string): Promise<MerklForecastState> => {
  // Use inFlight map to deduplicate concurrent requests for the same campaign
  const existingRequest = inFlight.get(campaignId);
  if (existingRequest) {
    return existingRequest;
  }

  const request = (async () => {
    try {
      const campaignOpportunityMetaMap = await getCampaignOpportunityMetaMap();
      const campaignOpportunityMeta = campaignOpportunityMetaMap.get(campaignId) ?? null;

      if (!campaignOpportunityMeta) {
        throw new Error(
          `Campaign ${campaignId} has unsupported or missing distribution type in opportunities`
        );
      }

      const campaignFromNetwork = !(
        campaignOpportunityMeta.campaignSnapshot &&
        canComputeForecastFromSnapshot(campaignOpportunityMeta.campaignSnapshot)
      );

      // metricsCache has dynamic TTL, so this may return cached data without API call
      const campaignPromise =
        campaignOpportunityMeta.campaignSnapshot &&
        canComputeForecastFromSnapshot(campaignOpportunityMeta.campaignSnapshot)
        ? Promise.resolve(campaignOpportunityMeta.campaignSnapshot)
        : fetchJson(`${MERKL_BASE_URL}/campaigns/${campaignId}`);
      const metricsPromise = getCachedOrFetchMetrics(campaignId);
      const [campaign, metricsResult] = await Promise.all([campaignPromise, metricsPromise]);
      const metrics = metricsResult.data;

      if (metricsResult.raw !== null) {
        await persistMerklDebugSnapshot({
          campaignId,
          ...(campaignFromNetwork ? { campaign } : {}),
          metrics: metricsResult.raw,
        });
      }

      const campaignType = campaignOpportunityMeta.campaignTypeHint;

      const startTs = toNumber(getAtPath(campaign, ['startTimestamp']));
      if (startTs === null) {
        throw new Error(`Missing start timestamp for campaign ${campaignId}`);
      }
      const endTs = toNumber(getAtPath(campaign, ['endTimestamp']));
      if (endTs === null) {
        throw new Error(`Missing end timestamp for campaign ${campaignId}`);
      }

      const totalBudget = extractNormalizedTotalBudget(campaign, campaignId);
      const nowTs = Math.floor(Date.now() / 1000);
      const dailyRewardsRecords = extractDailyRewardsRecords(
        metrics,
        campaignOpportunityMeta.useTokenRateInMetrics
      );
      const isZeroBaseline = dailyRewardsRecords.length === 0;
      if (isZeroBaseline) {
        const now = Date.now();
        const firstSeen = zeroBaselineFirstSeenAt.get(campaignId) ?? now;
        if (!zeroBaselineFirstSeenAt.has(campaignId)) {
          zeroBaselineFirstSeenAt.set(campaignId, now);
          pruneZeroBaselineCache();
        }
        const ageMs = now - firstSeen;
        if (ageMs > BACKEND_CACHE_TTL_MS.merklForecastZeroBaselineMaxAgeMs) {
          throw new Error(
            `Campaign ${campaignId} has had no Merkl metrics for ${Math.round(ageMs / 3_600_000)}h ` +
            `(max=${BACKEND_CACHE_TTL_MS.merklForecastZeroBaselineMaxAgeMs / 3_600_000}h); forecast excluded`
          );
        }
      } else {
        zeroBaselineFirstSeenAt.delete(campaignId);
      }
      const distributedSoFar = isZeroBaseline
        ? 0
        : Math.min(estimateDistributedSoFar(dailyRewardsRecords, startTs, endTs, nowTs), totalBudget);
      const aprCap =
        campaignType === 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' ||
        campaignType === 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
          ? extractMaxApr(campaign)
          : null;
      const latestTvl = campaignOpportunityMeta?.tvl ?? extractLatestTvl(metrics);

      return buildForecastState({
        campaignId,
        campaignType,
        totalBudget,
        aprCap,
        startTimestamp: startTs,
        endTimestamp: endTs,
        nowTimestamp: nowTs,
        distributedSoFar,
        latestTvl,
      });
    } catch (error) {
      logger.error(`❌ Failed to compute Merkl forecast state for ${campaignId}:`, error);
      throw error;
    } finally {
      inFlight.delete(campaignId);
    }
  })();

  inFlight.set(campaignId, request);
  return request;
};

export function getMerklForecastCacheStats(): {
  metricsCacheSize: number;
  zeroBaselineCacheSize: number;
  inFlightSize: number;
  campaignOpportunityCacheAge: number | null;
} {
  return {
    metricsCacheSize: metricsCache.size,
    zeroBaselineCacheSize: zeroBaselineFirstSeenAt.size,
    inFlightSize: inFlight.size,
    campaignOpportunityCacheAge: campaignOpportunityCache
      ? Date.now() - campaignOpportunityCache.updatedAt
      : null,
  };
}
