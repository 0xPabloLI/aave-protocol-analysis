import { logger } from '../logger.js';

const MERKL_BASE_URL = 'https://api.merkl.xyz/v4';
const SECONDS_PER_DAY = 86400;
const APR_DENOMINATOR = 365;
const MIN_REMAINING_DAYS = 0.0001;

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

interface CampaignTvlCacheEntry {
  data: Map<string, number>;
  expiresAt: number;
}

export interface MerklForecastState {
  campaignId: string;
  totalBudget: number;
  desiredDaily: number;
  remainingBudget: number;
  remainingDays: number;
  maxAPR: number;
  computedUntil: number | null;
  asOf: number;
  distributedSoFar: number;
  latestTvl: number;
  startTimestamp: number;
  endTimestamp: number;
  expectedByNow: number;
}

export interface ForecastAtTvlResult {
  dailyRewards: number;
  apr: number;
  capBinding: boolean;
  regime: 'APR_CAPPED' | 'BUDGET_LIMITED';
}

const forecastCache = new Map<string, ForecastCacheEntry>();
const inFlight = new Map<string, Promise<MerklForecastState>>();
let campaignTvlCache: CampaignTvlCacheEntry | null = null;

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

const isCappedCampaign = (campaign: unknown): boolean => {
  const candidates = [
    getAtPath(campaign, ['distributionMethod']),
    getAtPath(campaign, ['params', 'distributionMethod']),
    getAtPath(campaign, ['params', 'distributionMethodParameters', 'distributionMethod']),
    getAtPath(campaign, ['params', 'distributionMethodParameters', 'distributionType']),
    getAtPath(campaign, ['params', 'distributionMethodParameters', 'distributionSettings', 'type']),
    getAtPath(campaign, ['distributionType']),
  ];

  return candidates.some((value) => {
    if (typeof value !== 'string') return false;
    const normalized = value.toUpperCase();
    return normalized.includes('MAX_APR') || normalized.includes('MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE');
  });
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

const getCampaignTvlMap = async (): Promise<Map<string, number>> => {
  const now = Date.now();
  if (campaignTvlCache && campaignTvlCache.expiresAt > now) {
    return campaignTvlCache.data;
  }

  const [aaveOpps, tydroOpps] = await Promise.all([
    fetchJson(`${MERKL_BASE_URL}/opportunities?mainProtocolId=aave`).catch(() => []),
    fetchJson(`${MERKL_BASE_URL}/opportunities?mainProtocolId=tydro`).catch(() => []),
  ]);

  const allOpps = [
    ...(Array.isArray(aaveOpps) ? aaveOpps : []),
    ...(Array.isArray(tydroOpps) ? tydroOpps : []),
  ];

  const map = new Map<string, number>();
  allOpps.forEach((opp) => {
    const status = getAtPath(opp, ['status']);
    if (status !== 'LIVE') return;
    const tvl = toNumber(getAtPath(opp, ['tvl']));
    if (tvl === null || tvl < 0) return;
    const breakdowns = getAtPath(opp, ['rewardsRecord', 'breakdowns']);
    if (!Array.isArray(breakdowns)) return;
    breakdowns.forEach((b) => {
      const campaignId = getAtPath(b, ['campaignId']);
      if (typeof campaignId === 'string' && campaignId) {
        map.set(campaignId, tvl);
      }
    });
  });

  campaignTvlCache = {
    data: map,
    expiresAt: now + CACHE_TTL_MS,
  };
  return map;
};

const extractNormalizedTotalBudget = (campaign: unknown, campaignId: string): number => {
  const amountRaw = getAtPath(campaign, ['amount']);
  const amount = toNumber(amountRaw);
  if (amount === null) {
    throw new Error(`Missing campaign budget for campaign ${campaignId}`);
  }

  const decimals =
    toNumber(getAtPath(campaign, ['rewardToken', 'decimals'])) ??
    toNumber(getAtPath(campaign, ['params', 'decimalsRewardToken']));

  if (decimals !== null && decimals >= 0) {
    if (typeof amountRaw === 'string' && !amountRaw.includes('.')) {
      return amount / Math.pow(10, decimals);
    }
  }

  return amount;
};

const buildForecastState = (
  campaignId: string,
  campaign: unknown,
  metrics: unknown,
  opportunity: unknown | null,
  campaignTvlFromOpportunityIndex: number | null
): MerklForecastState => {
  const maxAPR = extractMaxApr(campaign);
  if (maxAPR === null) {
    throw new Error(`Missing max APR for campaign ${campaignId}`);
  }

  const totalBudget = extractNormalizedTotalBudget(campaign, campaignId);

  if (!isCappedCampaign(campaign)) {
    throw new Error(`Campaign ${campaignId} is not MAX_APR capped`);
  }

  const endTs = toNumber(getAtPath(campaign, ['endTimestamp']));
  if (endTs === null) {
    throw new Error(`Missing end timestamp for campaign ${campaignId}`);
  }
  const startTs = toNumber(getAtPath(campaign, ['startTimestamp']));
  if (startTs === null) {
    throw new Error(`Missing start timestamp for campaign ${campaignId}`);
  }

  const nowTs = Math.floor(Date.now() / 1000);
  const dailyRewardsRecords = extractDailyRewardsRecords(metrics);
  const distributedSoFar = Math.min(
    estimateDistributedSoFar(dailyRewardsRecords, startTs, endTs, nowTs),
    totalBudget
  );
  const remainingBudget = Math.max(totalBudget - distributedSoFar, 0);
  const remainingDays = Math.max((endTs - nowTs) / SECONDS_PER_DAY, MIN_REMAINING_DAYS);
  const desiredDaily = remainingBudget / remainingDays;
  const duration = Math.max(endTs - startTs, 1);
  const elapsed = Math.min(Math.max(nowTs - startTs, 0), duration);
  const expectedByNow = totalBudget * (elapsed / duration);

  return {
    campaignId,
    totalBudget,
    desiredDaily,
    remainingBudget,
    remainingDays,
    maxAPR,
    computedUntil: extractComputedUntil(campaign),
    asOf: nowTs,
    distributedSoFar,
    latestTvl:
      campaignTvlFromOpportunityIndex ??
      toNumber(getAtPath(opportunity, ['tvl'])) ??
      extractLatestTvl(metrics),
    startTimestamp: startTs,
    endTimestamp: endTs,
    expectedByNow,
  };
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
      const [campaign, metrics, campaignTvlMap] = await Promise.all([
        fetchJson(`${MERKL_BASE_URL}/campaigns/${campaignId}`),
        fetchJson(`${MERKL_BASE_URL}/campaigns/${campaignId}/metrics`),
        getCampaignTvlMap(),
      ]);
      const opportunityId = getAtPath(campaign, ['opportunityId']);
      const opportunity =
        typeof opportunityId === 'string' && opportunityId
          ? await fetchJson(`${MERKL_BASE_URL}/opportunities/${opportunityId}`).catch(() => null)
          : null;
      const state = buildForecastState(
        campaignId,
        campaign,
        metrics,
        opportunity,
        campaignTvlMap.get(campaignId) ?? null
      );
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

export const forecastWithTvl = (state: MerklForecastState, hypotheticalTVL: number): ForecastAtTvlResult => {
  const safeTvl = Number.isFinite(hypotheticalTVL) ? Math.max(hypotheticalTVL, 0) : 0;
  if (safeTvl <= 0) {
    return {
      dailyRewards: 0,
      apr: 0,
      capBinding: true,
      regime: 'APR_CAPPED',
    };
  }

  const capDaily = (safeTvl * state.maxAPR) / APR_DENOMINATOR;
  const dailyRewards = Math.min(state.desiredDaily, capDaily);
  const apr = (dailyRewards * APR_DENOMINATOR) / safeTvl;
  const capBinding = capDaily < state.desiredDaily;

  return {
    dailyRewards,
    apr,
    capBinding,
    regime: capBinding ? 'APR_CAPPED' : 'BUDGET_LIMITED',
  };
};
