const SECONDS_PER_DAY = 86400;
const MIN_REMAINING_DAYS = 0.0001;

export type CampaignForecastType =
  | 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  | 'DUTCH_AUCTION'
  | 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE';

export interface BuildForecastStateInput {
  campaignId: string;
  campaignType: CampaignForecastType;
  totalBudget: number;
  aprCap: number | null;
  startTimestamp: number;
  endTimestamp: number;
  nowTimestamp: number;
  distributedSoFar: number;
  latestTvl: number;
}

export interface MerklForecastState {
  campaignId: string;
  campaignType: CampaignForecastType;
  totalBudget: number;
  // Fixed baseline daily budget over the full campaign window.
  plannedDaily: number;
  // Dynamic target daily budget for remaining time. Only meaningful for non-DUTCH types;
  // DUTCH_AUCTION always equals plannedDaily and is omitted from the API response.
  requiredDaily: number;
  remainingBudget: number;
  remainingDays: number;
  aprCap: number | null;
  asOf: number;
  distributedSoFar: number;
  latestTvl: number;
  startTimestamp: number;
  endTimestamp: number;
}

const safeNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

export const normalizeCampaignType = (value: unknown): CampaignForecastType | null => {
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
    return 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE';
  }
  if (normalized.includes('AAVE_V4_NET_APR')) {
    return 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE';
  }
  return null;
};

export const buildForecastState = (input: BuildForecastStateInput): MerklForecastState => {
  const totalBudget = Math.max(safeNumber(input.totalBudget), 0);
  const startTs = Math.max(safeNumber(input.startTimestamp), 0);
  const endTs = Math.max(safeNumber(input.endTimestamp), startTs);
  const nowTs = Math.max(safeNumber(input.nowTimestamp), 0);
  const distributedSoFar = Math.min(Math.max(safeNumber(input.distributedSoFar), 0), totalBudget);
  const latestTvl = Math.max(safeNumber(input.latestTvl), 0);

  const rawAprCap =
    input.campaignType === 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' ||
    input.campaignType === 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
      ? safeNumber(input.aprCap, NaN)
      : null;
  if (
    input.campaignType === 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' ||
    input.campaignType === 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  ) {
    if (rawAprCap === null || !Number.isFinite(rawAprCap) || rawAprCap <= 0) {
      throw new Error(`Missing APR cap for campaign ${input.campaignId}`);
    }
  }
  const aprCap =
    input.campaignType === 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' ||
    input.campaignType === 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
      ? rawAprCap
      : null;

  const remainingBudget = Math.max(totalBudget - distributedSoFar, 0);
  const remainingDays = Math.max((endTs - nowTs) / SECONDS_PER_DAY, MIN_REMAINING_DAYS);
  const totalDays = Math.max((endTs - startTs) / SECONDS_PER_DAY, MIN_REMAINING_DAYS);
  const plannedDaily = totalBudget / totalDays;
  const requiredDaily =
    input.campaignType === 'DUTCH_AUCTION'
      ? plannedDaily
      : remainingBudget / remainingDays;

  return {
    campaignId: input.campaignId,
    campaignType: input.campaignType,
    totalBudget,
    plannedDaily,
    requiredDaily,
    remainingBudget,
    remainingDays,
    aprCap,
    asOf: nowTs,
    distributedSoFar,
    latestTvl,
    startTimestamp: startTs,
    endTimestamp: endTs,
  };
};
