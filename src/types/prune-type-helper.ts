/**
 * Prune Function Type Safety Helpers
 * 
 * 这些类型工具确保 pruneReserveForRuntime 函数处理所有 RuntimeReserveData 字段
 */

import type { FormattedReserveData, RuntimeReserveData } from '../index.js';

/**
 * 类型级测试：确保 FormattedReserveData 包含 RuntimeReserveData 的所有字段（除了 deficit）
 * 
 * 如果 RuntimeReserveData 有字段而 FormattedReserveData 没有，这里会编译报错
 */
export type ValidateSourceCoverage = {
  [K in keyof Omit<RuntimeReserveData, 'deficit'>]: 
    K extends keyof FormattedReserveData 
      ? FormattedReserveData[K] extends RuntimeReserveData[K] ? true : never
      : never;
};

/**
 * 辅助类型：提取所有可选字段的联合类型
 */
export type OptionalKeys<T> = {
  [K in keyof T]-?: {} extends { [P in K]: T[K] } ? K : never;
}[keyof T];

/**
 * 辅助类型：提取所有必填字段的联合类型
 */
export type RequiredKeys<T> = {
  [K in keyof T]-?: {} extends { [P in K]: T[K] } ? never : K;
}[keyof T];

/**
 * 用于 prune 函数返回值的类型断言 helper
 * 
 * 用法：
 * ```typescript
 * function pruneReserveForRuntime(item: FormattedReserveData): RuntimeReserveData {
 *   const result = {
 *     // ... 构建对象
 *   };
 *   
 *   // 这行会在编译时验证 result 包含所有 RuntimeReserveData 字段
 *   return assertRuntimeReserveData(result);
 * }
 * ```
 */
// ts-prune-ignore-next (public helper for callers that opt in)
export function assertRuntimeReserveData(
  data: RuntimeReserveData
): RuntimeReserveData {
  return data;
}

/**
 * 部分字段映射辅助类型
 * 用于指导 prune 函数需要处理哪些字段
 */
// ts-prune-ignore-next (public type for documentation/tooling)
export type PruneFieldMapping = {
  // 必填字段（直接复制）
  [K in RequiredKeys<RuntimeReserveData>]: K extends keyof FormattedReserveData 
    ? { source: K; transform: 'direct' }
    : { source: null; transform: 'manual' };
} & {
  // 可选字段（条件复制）
  [K in OptionalKeys<RuntimeReserveData>]: K extends keyof FormattedReserveData
    ? { source: K; transform: 'conditional' }
    : { source: null; transform: 'manual' };
};

/**
 * 编译时验证：确保 prune 函数处理了所有字段
 * 
 * 如果 pruneReserveForRuntime 缺少返回类型或字段不匹配，会编译报错
 */
// ts-prune-ignore-next (public type for compile-time validation)
export type ValidatePruneFunction<TFn extends (item: FormattedReserveData) => RuntimeReserveData> = 
  TFn extends (item: FormattedReserveData) => infer R 
    ? R extends RuntimeReserveData 
      ? true 
      : never 
    : never;

/**
 * 运行时验证：检查返回对象是否包含所有期望的字段
 * 用于开发和测试阶段发现遗漏
 */
// ts-prune-ignore-next (used by tests/dev tooling, not src)
export function validatePruneResult(
  result: Record<string, unknown>
): { valid: boolean; missing: string[]; extra: string[] } {
  const expectedFields: (keyof RuntimeReserveData)[] = [
    'reserveId', 'marketName', 'chainName', 'chainId', 'tokenName',
    'tokenSymbol', 'tokenAddress', 'tokenPrice', 'reserveSizeUsd',
    'utilizationPct', 'aTokenAddress', 'vTokenAddress', 'supplyApy',
    'supplyDisabled', 'isFrozen', 'isPaused', 'supplyCapUsd',
    'borrowApy', 'borrowDisabled', 'borrowCapUsd', 'supplyIncentives',
    'borrowIncentives', 'decimals', 'availableLiquidity', 'totalVariableDebt',
    'reserveFactor', 'variableRateSlope1', 'variableRateSlope2',
    'optimalUsageRate', 'baseVariableBorrowRate', 'deficit',
    'aaveProReserveId', 'meritSupplys', 'meritBorrows', 'merklSupplys',
    'merklBorrows', 'merklHolds', 'brevisSupplys', 'brevisBorrows',
    'hubId', 'hubName', 'hubAddress', 'spokeId', 'spokeName', 'spokeAddress',
  ];
  
  const missing: string[] = [];
  for (const field of expectedFields) {
    if (!(field in result)) {
      missing.push(field);
    }
  }
  
  const extra: string[] = [];
  for (const key of Object.keys(result)) {
    if (!expectedFields.includes(key as keyof RuntimeReserveData)) {
      extra.push(key);
    }
  }
  
  return {
    valid: missing.length === 0,
    missing,
    extra,
  };
}
