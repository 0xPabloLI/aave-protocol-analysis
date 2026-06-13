/**
 * Merkl API Contract - 集中定义各 campaignType 的字段映射规则
 * 
 * 原则：
 * 1. 计算层（merklForecastModel）保持完整字段，用于内部复用
 * 2. API 层通过本 contract 决定对外暴露哪些字段
 * 3. 新增/修改类型只需改此配置表，无需修改多处条件分支
 */

export type CampaignForecastType =
  | 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  | 'DUTCH_AUCTION'
  | 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  | 'TARGET_TOTAL_APR';

/** Forecast API 字段模式 */
export type ForecastFieldMode = 'none' | 'fix' | 'max';

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

/** Campaign type 到 breakdown 字段规则的映射 */
export const BREAKDOWN_FIELD_RULES: Record<CampaignForecastType, BreakdownFieldRule> = {
  DUTCH_AUCTION: {
    omit: ['aprCap', 'totalBudget'],
  },
  FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE: {
    omit: ['plannedDaily'],
  },
  MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE: {
    omit: [],
  },
  TARGET_TOTAL_APR: {
    omit: [],
  },
};

/** Campaign type 到 forecast 字段规则的映射 */
export const FORECAST_FIELD_RULES: Record<CampaignForecastType, ForecastFieldRule> = {
  DUTCH_AUCTION: {
    mode: 'none',
    includeRequiredDaily: false,
    includeDistributedSoFar: false,
    includeEndTimestamp: false,
  },
  FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE: {
    mode: 'fix',
    includeRequiredDaily: false,
    includeDistributedSoFar: true,
    includeEndTimestamp: true,
  },
  MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE: {
    mode: 'max',
    includeRequiredDaily: true,
    includeDistributedSoFar: true,
    includeEndTimestamp: true,
  },
  TARGET_TOTAL_APR: {
    mode: 'max',
    includeRequiredDaily: true,
    includeDistributedSoFar: true,
    includeEndTimestamp: true,
  },
};

/** 获取指定类型的 breakdown 字段规则 */
export function getBreakdownFieldRule(type: CampaignForecastType): BreakdownFieldRule {
  return BREAKDOWN_FIELD_RULES[type];
}

/** 获取指定类型的 forecast 字段规则 */
export function getForecastFieldRule(type: CampaignForecastType): ForecastFieldRule {
  return FORECAST_FIELD_RULES[type];
}

/** 判断 forecast 类型是否应生成条目（DUTCH_AUCTION 返回 null） */
export function shouldIncludeForecastItem(type: CampaignForecastType): boolean {
  return getForecastFieldRule(type).mode !== 'none';
}
