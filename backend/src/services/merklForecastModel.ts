const SECONDS_PER_DAY = 86400;
const MIN_REMAINING_DAYS = 0.0001;

export type CampaignForecastType =
  | 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  | 'DUTCH_AUCTION'
  | 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  | 'UNSUPPORTED'
  | 'UNKNOWN';

export interface BuildForecastStateInput {
  campaignId: string;
  campaignType: CampaignForecastType;
  totalBudget: number;
  maxAPR: number | null;
  startTimestamp: number;
  endTimestamp: number;
  nowTimestamp: number;
  distributedSoFar: number;
  latestTvl: number;
  computedUntil: number | null;
}

export interface MerklForecastState {
  campaignId: string;
  campaignType: Exclude<CampaignForecastType, 'UNSUPPORTED' | 'UNKNOWN'>;
  totalBudget: number;
  // Fixed baseline daily budget over the full campaign window.
  plannedDaily: number;
  // Dynamic target daily budget for remaining time (for DUTCH, equals plannedDaily).
  requiredDaily: number;
  remainingBudget: number;
  remainingDays: number;
  maxAPR: number | null;
  computedUntil: number | null;
  asOf: number;
  distributedSoFar: number;
  latestTvl: number;
  startTimestamp: number;
  endTimestamp: number;
  expectedByNow: number;
}

const safeNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

const getAtPath = (obj: unknown, path: string[]): unknown => {
  let current: unknown = obj;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
};

export const normalizeCampaignType = (value: unknown): CampaignForecastType => {
  if (typeof value !== 'string') return 'UNKNOWN';
  const normalized = value.trim().toUpperCase();
  if (!normalized) return 'UNKNOWN';

  if (normalized.includes('MAX_APR') || normalized.includes('MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE')) {
    return 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE';
  }
  if (normalized.includes('DUTCH_AUCTION')) {
    return 'DUTCH_AUCTION';
  }
  if (normalized.includes('FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE') || normalized.includes('FIX_APR')) {
    return 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE';
  }
  return 'UNSUPPORTED';
};

export const resolveCampaignType = (
  opportunityHint: CampaignForecastType,
  campaign: unknown
): CampaignForecastType => {
  if (
    opportunityHint === 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' ||
    opportunityHint === 'DUTCH_AUCTION' ||
    opportunityHint === 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  ) {
    return opportunityHint;
  }

  const candidates = [
    getAtPath(campaign, ['distributionType']),
    getAtPath(campaign, ['distributionMethod']),
    getAtPath(campaign, ['params', 'distributionMethod']),
    getAtPath(campaign, ['params', 'distributionMethodParameters', 'distributionMethod']),
    getAtPath(campaign, ['params', 'distributionMethodParameters', 'distributionType']),
    getAtPath(campaign, ['params', 'distributionMethodParameters', 'distributionSettings', 'type']),
  ];

  let unsupportedSeen = opportunityHint === 'UNSUPPORTED';
  for (const candidate of candidates) {
    const type = normalizeCampaignType(candidate);
    if (
      type === 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' ||
      type === 'DUTCH_AUCTION' ||
      type === 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
    ) {
      return type;
    }
    if (type === 'UNSUPPORTED') unsupportedSeen = true;
  }

  return unsupportedSeen ? 'UNSUPPORTED' : 'UNKNOWN';
};

export const buildForecastState = (input: BuildForecastStateInput): MerklForecastState => {
  const totalBudget = Math.max(safeNumber(input.totalBudget), 0);
  const startTs = Math.max(safeNumber(input.startTimestamp), 0);
  const endTs = Math.max(safeNumber(input.endTimestamp), startTs);
  const nowTs = Math.max(safeNumber(input.nowTimestamp), 0);
  const distributedSoFar = Math.min(Math.max(safeNumber(input.distributedSoFar), 0), totalBudget);
  const latestTvl = Math.max(safeNumber(input.latestTvl), 0);

  if (
    input.campaignType !== 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' &&
    input.campaignType !== 'DUTCH_AUCTION' &&
    input.campaignType !== 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  ) {
    throw new Error(`Campaign ${input.campaignId} has unsupported distribution type`);
  }

  const rawMaxApr =
    input.campaignType === 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' ||
    input.campaignType === 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
      ? safeNumber(input.maxAPR, NaN)
      : null;
  if (
    input.campaignType === 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' ||
    input.campaignType === 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  ) {
    if (rawMaxApr === null || !Number.isFinite(rawMaxApr) || rawMaxApr <= 0) {
      throw new Error(`Missing max APR for campaign ${input.campaignId}`);
    }
  }
  const maxAPR =
    input.campaignType === 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' ||
    input.campaignType === 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
      ? rawMaxApr
      : null;

  const remainingBudget = Math.max(totalBudget - distributedSoFar, 0);
  const remainingDays = Math.max((endTs - nowTs) / SECONDS_PER_DAY, MIN_REMAINING_DAYS);
  const totalDays = Math.max((endTs - startTs) / SECONDS_PER_DAY, MIN_REMAINING_DAYS);
  const plannedDaily = totalBudget / totalDays;
  const requiredDaily =
    input.campaignType === 'DUTCH_AUCTION'
      ? plannedDaily
      : remainingBudget / remainingDays;
  const duration = Math.max(endTs - startTs, 1);
  const elapsed = Math.min(Math.max(nowTs - startTs, 0), duration);
  const expectedByNow = totalBudget * (elapsed / duration);

  return {
    campaignId: input.campaignId,
    campaignType: input.campaignType,
    totalBudget,
    plannedDaily,
    requiredDaily,
    remainingBudget,
    remainingDays,
    maxAPR,
    computedUntil: input.computedUntil,
    asOf: nowTs,
    distributedSoFar,
    latestTvl,
    startTimestamp: startTs,
    endTimestamp: endTs,
    expectedByNow,
  };
};
