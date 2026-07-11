const SECONDS_PER_DAY = 86400;
const MIN_REMAINING_DAYS = 0.0001;

export type CampaignForecastType =
  | 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  | 'DUTCH_AUCTION'
  | 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  | 'TARGET_TOTAL_APR'
  | 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE'
  | 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT'
  | 'MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT';

export interface BuildForecastStateInput {
  campaignId: string;
  campaignType: CampaignForecastType;
  budgetBoundMode?: string;
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
  budgetBoundMode?: string;
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

export interface NormalizeCampaignTypeInput {
  distributionType?: string;
  targetAPR?: number | string;
}

const DISTRIBUTION_TYPE_PATTERNS: Array<{ pattern: string; result: CampaignForecastType }> = [
  { pattern: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE', result: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' },
  { pattern: 'MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT', result: 'MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT' },
  { pattern: 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE', result: 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE' },
  { pattern: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE', result: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE' },
  { pattern: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT', result: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT' },
  { pattern: 'DUTCH_AUCTION', result: 'DUTCH_AUCTION' },
  { pattern: 'AAVE_NET_APR', result: 'TARGET_TOTAL_APR' },
  { pattern: 'AAVE_V4_NET_APR', result: 'TARGET_TOTAL_APR' },
  { pattern: 'ERC4626_APR', result: 'TARGET_TOTAL_APR' },
  { pattern: 'ERC4626_SPREAD_CAPPED', result: 'TARGET_TOTAL_APR' },
  { pattern: 'ERC4626_TARGET_APR_WITH_MERKL', result: 'TARGET_TOTAL_APR' },
  { pattern: 'SOFR_SPREAD_RATCHET', result: 'TARGET_TOTAL_APR' },
  { pattern: 'DEEL_DISTRIBUTION', result: 'TARGET_TOTAL_APR' },
];

const normalizeByDistributionType = (value: string | undefined): CampaignForecastType | null => {
  if (!value) return null;
  const upper = value.trim().toUpperCase();
  for (const { pattern, result } of DISTRIBUTION_TYPE_PATTERNS) {
    if (upper === pattern) return result;
  }
  return null;
};

const toFinitePositiveNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
};

export const normalizeCampaignType = (input: NormalizeCampaignTypeInput | unknown): CampaignForecastType | null => {
  if (!input || typeof input !== 'object') return null;
  const { distributionType, targetAPR } = input as NormalizeCampaignTypeInput;

  return (
    normalizeByDistributionType(distributionType) ??
    (toFinitePositiveNumber(targetAPR) !== null ? 'TARGET_TOTAL_APR' : null)
  );
};

export const buildForecastState = (input: BuildForecastStateInput): MerklForecastState => {
  const totalBudget = Math.max(safeNumber(input.totalBudget), 0);
  const startTs = Math.max(safeNumber(input.startTimestamp), 0);
  const endTs = Math.max(safeNumber(input.endTimestamp), startTs);
  const nowTs = Math.max(safeNumber(input.nowTimestamp), 0);
  const distributedSoFar = Math.min(Math.max(safeNumber(input.distributedSoFar), 0), totalBudget);
  const latestTvl = Math.max(safeNumber(input.latestTvl), 0);

  const needsAprCap =
    input.campaignType === 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' ||
    input.campaignType === 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE' ||
    input.campaignType === 'TARGET_TOTAL_APR' ||
    input.campaignType === 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE' ||
    input.campaignType === 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT' ||
    input.campaignType === 'MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT';

  const rawAprCap = needsAprCap ? safeNumber(input.aprCap, NaN) : null;
  if (needsAprCap) {
    if (rawAprCap === null || !Number.isFinite(rawAprCap) || rawAprCap <= 0) {
      throw new Error(`Missing APR cap for campaign ${input.campaignId}`);
    }
  }
  const aprCap = needsAprCap ? rawAprCap : null;

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
    budgetBoundMode: input.budgetBoundMode,
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
