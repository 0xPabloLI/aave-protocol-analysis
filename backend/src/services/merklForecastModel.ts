import type { ForecastCampaignTypeLite } from "@internal/aave-shared-contracts";

const SECONDS_PER_DAY = 86400;
const MIN_REMAINING_DAYS = 0.0001;

export interface BuildForecastStateInput {
  campaignId: string;
  campaignType: ForecastCampaignTypeLite;
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
  campaignType: ForecastCampaignTypeLite;
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
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

export const buildForecastState = (
  input: BuildForecastStateInput
): MerklForecastState => {
  const totalBudget = Math.max(safeNumber(input.totalBudget), 0);
  const startTs = Math.max(safeNumber(input.startTimestamp), 0);
  const endTs = Math.max(safeNumber(input.endTimestamp), startTs);
  const nowTs = Math.max(safeNumber(input.nowTimestamp), 0);
  const distributedSoFar = Math.min(
    Math.max(safeNumber(input.distributedSoFar), 0),
    totalBudget
  );
  const latestTvl = Math.max(safeNumber(input.latestTvl), 0);

  const needsAprCap =
    input.campaignType === "MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE" ||
    input.campaignType === "FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE" ||
    input.campaignType === "TARGET_TOTAL_APR" ||
    input.campaignType === "FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE" ||
    input.campaignType === "FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT" ||
    input.campaignType === "MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT";

  const rawAprCap = needsAprCap ? safeNumber(input.aprCap, NaN) : null;
  if (needsAprCap) {
    if (rawAprCap === null || !Number.isFinite(rawAprCap) || rawAprCap <= 0) {
      throw new Error(`Missing APR cap for campaign ${input.campaignId}`);
    }
  }
  const aprCap = needsAprCap ? rawAprCap : null;

  const remainingBudget = Math.max(totalBudget - distributedSoFar, 0);
  const remainingDays = Math.max(
    (endTs - nowTs) / SECONDS_PER_DAY,
    MIN_REMAINING_DAYS
  );
  const totalDays = Math.max(
    (endTs - startTs) / SECONDS_PER_DAY,
    MIN_REMAINING_DAYS
  );
  const plannedDaily = totalBudget / totalDays;
  const requiredDaily =
    input.campaignType === "DUTCH_AUCTION"
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
