import { logger } from '../logger.js';
import {
  buildForecastState,
  normalizeCampaignType,
  type CampaignForecastType,
  type MerklForecastState,
} from './merklForecastModel.js';
import { fetchMerklOpportunities } from './merklOpportunityClient.js';

const MERKL_BASE_URL = 'https://api.merkl.xyz/v4';
const SECONDS_PER_DAY = 86400;

const CACHE_TTL_MS = (() => {
  const raw = process.env.MERKL_FORECAST_CACHE_TTL_MS;
  if (!raw) return 3 * 60 * 1000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3 * 60 * 1000;
})();

interface ForecastCacheEntry {
  data: MerklForecastState;
  expiresAt: number;
}

interface CampaignOpportunityMeta {
  tvl: number;
  campaignTypeHint: CampaignForecastType;
  distributionTypeRaw: string | null;
  campaignSnapshot: unknown | null;
}

interface CampaignOpportunityCacheEntry {
  data: Map<string, CampaignOpportunityMeta>;
  expiresAt: number;
}

const forecastCache = new Map<string, ForecastCacheEntry>();
const inFlight = new Map<string, Promise<MerklForecastState>>();
let campaignOpportunityCache: CampaignOpportunityCacheEntry | null = null;

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

const getAtPath = (obj: unknown, path: string[]): unknown => {
  let current: unknown = obj;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
};

const normalizeApr = (raw: number): number => {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw > 1 ? raw / 100 : raw;
};

const extractMaxApr = (campaign: unknown): number | null => {
  const directCandidates: Array<string[]> = [
    ['params', 'distributionMethodParameters', 'distributionSettings', 'apr'],
    ['distributionMethodParameters', 'distributionSettings', 'apr'],
    ['distributionSettings', 'apr'],
    ['apr'],
  ];

  for (const path of directCandidates) {
    const value = toNumber(getAtPath(campaign, path));
    if (value !== null) return normalizeApr(value);
  }

  return null;
};

const extractComputedUntil = (campaign: unknown): number | null => {
  const value = toNumber(getAtPath(campaign, ['campaignStatus', 'computedUntil']));
  return value !== null ? value : null;
};

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

const extractDailyRewardsRecords = (metrics: unknown): TimeSeriesPoint[] => {
  const raw = getAtPath(metrics, ['dailyRewardsRecords']);
  if (!Array.isArray(raw)) return [];

  return raw
    .map((entry) => ({
      timestamp: toNumber(getAtPath(entry, ['timestamp'])) || 0,
      total: toNumber(getAtPath(entry, ['total'])) || 0,
    }))
    .filter((entry) => entry.timestamp > 0 && entry.total >= 0)
    .sort((a, b) => a.timestamp - b.timestamp);
};

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

const fetchJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`Merkl API ${response.status} for ${url}`);
  }
  return response.json() as Promise<unknown>;
};

const getCampaignOpportunityMetaMap = async (): Promise<Map<string, CampaignOpportunityMeta>> => {
  const now = Date.now();
  if (campaignOpportunityCache && campaignOpportunityCache.expiresAt > now) {
    return campaignOpportunityCache.data;
  }

  const allOpps = await fetchMerklOpportunities({
    mainProtocolId: 'aave,tydro',
    status: 'LIVE',
    campaigns: true,
    itemsPerPage: 100,
  });

  const map = new Map<string, CampaignOpportunityMeta>();
  allOpps.forEach((opp) => {
    const tvl = toNumber(getAtPath(opp, ['tvl']));
    if (tvl === null || tvl < 0) return;
    const oppDistributionTypeRaw = getAtPath(opp, ['distributionType']);
    const breakdowns = getAtPath(opp, ['rewardsRecord', 'breakdowns']);
    if (!Array.isArray(breakdowns)) return;
    const oppCampaignsRaw = getAtPath(opp, ['campaigns']);
    const oppCampaigns = Array.isArray(oppCampaignsRaw) ? oppCampaignsRaw : [];
    const campaignSnapshotById = new Map<string, unknown>();
    oppCampaigns.forEach((campaign) => {
      const id = getAtPath(campaign, ['id']);
      if (typeof id === 'string' && id) {
        campaignSnapshotById.set(id, campaign);
      }
    });

    breakdowns.forEach((breakdown) => {
      const campaignId = getAtPath(breakdown, ['campaignId']);
      if (typeof campaignId !== 'string' || !campaignId) return;
      const campaignSnapshot = campaignSnapshotById.get(campaignId) ?? null;

      const breakdownDistributionTypeRaw =
        getAtPath(breakdown, ['distributionType']) ?? getAtPath(breakdown, ['distributionMethod']);
      const rawType =
        (typeof breakdownDistributionTypeRaw === 'string' && breakdownDistributionTypeRaw) ||
        (typeof oppDistributionTypeRaw === 'string' && oppDistributionTypeRaw) ||
        null;
      const hintType = normalizeCampaignType(rawType);
      if (!hintType) return;

      const previous = map.get(campaignId);
      if (!previous) {
        map.set(campaignId, {
          tvl,
          campaignTypeHint: hintType,
          distributionTypeRaw: rawType,
          campaignSnapshot,
        });
        return;
      }

      map.set(campaignId, {
        tvl: previous.tvl > 0 ? previous.tvl : tvl,
        campaignTypeHint: previous.campaignTypeHint,
        distributionTypeRaw: previous.distributionTypeRaw ?? rawType,
        campaignSnapshot: previous.campaignSnapshot ?? campaignSnapshot,
      });
    });
  });

  campaignOpportunityCache = {
    data: map,
    expiresAt: now + CACHE_TTL_MS,
  };
  return map;
};

export const extractNormalizedTotalBudget = (campaign: unknown, campaignId: string): number => {
  const amountRaw = getAtPath(campaign, ['amount']);
  const amount = toNumber(amountRaw);
  if (amount === null) {
    throw new Error(`Missing campaign budget for campaign ${campaignId}`);
  }

  const decimals =
    toNumber(getAtPath(campaign, ['rewardToken', 'decimals'])) ??
    toNumber(getAtPath(campaign, ['params', 'decimalsRewardToken']));

  let rewardAmount = amount;
  if (decimals !== null && decimals >= 0) {
    if (typeof amountRaw === 'string' && !amountRaw.includes('.')) {
      rewardAmount = amount / Math.pow(10, decimals);
    }
  }

  const rewardTokenPrice = toNumber(getAtPath(campaign, ['rewardToken', 'price']));
  if (rewardTokenPrice !== null && rewardTokenPrice > 0) {
    return rewardAmount * rewardTokenPrice;
  }
  return rewardAmount;
};

export const getMerklForecastState = async (campaignId: string): Promise<MerklForecastState> => {
  const now = Date.now();
  const cached = forecastCache.get(campaignId);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

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

      const campaignPromise = campaignOpportunityMeta.campaignSnapshot
        ? Promise.resolve(campaignOpportunityMeta.campaignSnapshot)
        : fetchJson(`${MERKL_BASE_URL}/campaigns/${campaignId}`);
      const metricsPromise = fetchJson(`${MERKL_BASE_URL}/campaigns/${campaignId}/metrics`);
      const [campaign, metrics] = await Promise.all([campaignPromise, metricsPromise]);

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
      const dailyRewardsRecords = extractDailyRewardsRecords(metrics);
      const distributedSoFar = Math.min(
        estimateDistributedSoFar(dailyRewardsRecords, startTs, endTs, nowTs),
        totalBudget
      );
      const aprCap =
        campaignType === 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' ||
        campaignType === 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
          ? extractMaxApr(campaign)
          : null;
      const latestTvl = campaignOpportunityMeta?.tvl ?? extractLatestTvl(metrics);

      const state = buildForecastState({
        campaignId,
        campaignType,
        totalBudget,
        aprCap,
        startTimestamp: startTs,
        endTimestamp: endTs,
        nowTimestamp: nowTs,
        distributedSoFar,
        latestTvl,
        computedUntil: extractComputedUntil(campaign),
      });

      forecastCache.set(campaignId, {
        data: state,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      return state;
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
