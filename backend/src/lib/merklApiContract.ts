/**
 * Merkl API Contract - 集中定义各 campaignType 的字段映射规则
 *
 * 原则：
 * 1. 计算层（merklForecastModel）保持完整字段，用于内部复用
 * 2. API 层通过本 contract 决定对外暴露哪些字段
 * 3. 新增/修改类型只需改此配置表，无需修改多处条件分支
 */

import type { ForecastCampaignTypeLite } from "@internal/aave-shared-contracts";

/** Forecast API 字段模式 */
export type ForecastFieldMode = "none" | "fix" | "max";

/** Merkl breakdown API 字段规则 */
export interface BreakdownFieldRule {
  /** 需要删除的字段（其余字段保留） */
  omit: string[];
}

/** Forecast API 字段规则 */
export interface ForecastFieldRule {
  mode: ForecastFieldMode;
  /** 是否包含 requiredDaily */
  includeRequiredDaily: boolean;
  /** 是否包含 distributedSoFar */
  includeDistributedSoFar: boolean;
  /** 是否包含 endTimestamp */
  includeEndTimestamp: boolean;
}

/** Campaign type 到 breakdown 字段规则的映射（TARGET_TOTAL_APR 无独立规则，由 budgetBoundMode 决定） */
export const BREAKDOWN_FIELD_RULES: Record<
  Exclude<ForecastCampaignTypeLite, "TARGET_TOTAL_APR">,
  BreakdownFieldRule
> = {
  DUTCH_AUCTION: {
    omit: ["aprCap", "totalBudget"],
  },
  FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE: {
    omit: ["plannedDaily"],
  },
  MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE: {
    omit: [],
  },
  FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE: {
    omit: ["plannedDaily"],
  },
  FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT: {
    omit: ["plannedDaily"],
  },
  MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT: {
    omit: [],
  },
};

/** Campaign type 到 forecast 字段规则的映射（TARGET_TOTAL_APR 无独立规则，由 budgetBoundMode 决定） */
export const FORECAST_FIELD_RULES: Record<
  Exclude<ForecastCampaignTypeLite, "TARGET_TOTAL_APR">,
  ForecastFieldRule
> = {
  DUTCH_AUCTION: {
    mode: "none",
    includeRequiredDaily: false,
    includeDistributedSoFar: false,
    includeEndTimestamp: false,
  },
  FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE: {
    mode: "fix",
    includeRequiredDaily: false,
    includeDistributedSoFar: true,
    includeEndTimestamp: true,
  },
  MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE: {
    mode: "max",
    includeRequiredDaily: true,
    includeDistributedSoFar: true,
    includeEndTimestamp: true,
  },
  FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE: {
    mode: "fix",
    includeRequiredDaily: false,
    includeDistributedSoFar: true,
    includeEndTimestamp: true,
  },
  FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT: {
    mode: "fix",
    includeRequiredDaily: false,
    includeDistributedSoFar: true,
    includeEndTimestamp: true,
  },
  MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT: {
    mode: "max",
    includeRequiredDaily: true,
    includeDistributedSoFar: true,
    includeEndTimestamp: true,
  },
};

/** 获取指定类型的 breakdown 字段规则 */
export function getBreakdownFieldRule(
  type: ForecastCampaignTypeLite,
  budgetBoundMode?: string
): BreakdownFieldRule {
  if (type === "TARGET_TOTAL_APR") {
    const mode = budgetBoundMode || "MAX_APR";
    if (mode === "FIX_APR")
      return BREAKDOWN_FIELD_RULES.FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE;
    return BREAKDOWN_FIELD_RULES.MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE;
  }
  return BREAKDOWN_FIELD_RULES[type];
}

/** 获取指定类型的 forecast 字段规则 */
export function getForecastFieldRule(
  type: ForecastCampaignTypeLite,
  budgetBoundMode?: string
): ForecastFieldRule {
  if (type === "TARGET_TOTAL_APR") {
    const mode = budgetBoundMode || "MAX_APR";
    if (mode === "FIX_APR")
      return FORECAST_FIELD_RULES.FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE;
    return FORECAST_FIELD_RULES.MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE;
  }
  return FORECAST_FIELD_RULES[type];
}

/** 判断 forecast 类型是否应生成条目（DUTCH_AUCTION 返回 false） */
export function shouldIncludeForecastItem(
  type: ForecastCampaignTypeLite,
  budgetBoundMode?: string
): boolean {
  return getForecastFieldRule(type, budgetBoundMode).mode !== "none";
}
