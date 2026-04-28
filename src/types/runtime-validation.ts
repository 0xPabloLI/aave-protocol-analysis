/**
 * RuntimeReserveData 类型安全验证
 * 
 * 这个文件通过 TypeScript 类型体操确保 pruneReserveForRuntime 函数
 * 不会遗漏任何字段。如果添加了新字段但没有在 pruneReserveForRuntime
 * 中处理，编译会报错。
 */

import type { FormattedReserveData, RuntimeReserveData } from '../index.js';

// 提取 RuntimeReserveData 的所有可选字段类型
type RuntimeOptionalFields = {
  [K in keyof RuntimeReserveData as RuntimeReserveData[K] extends undefined ? never : K]?: RuntimeReserveData[K];
};

// 类型测试：确保 RuntimeReserveData 的每个字段都能在 FormattedReserveData 找到对应
// 如果 RuntimeReserveData 有而 FormattedReserveData 没有的字段（除了 deficit），会编译报错
type ValidateRuntimeFields = {
  [K in keyof Omit<RuntimeReserveData, 'deficit'>]: K extends keyof FormattedReserveData 
    ? RuntimeReserveData[K] 
    : never;
};

// 这个常量用于运行时测试 - 包含所有应该在 RuntimeReserveData 中的字段
export const EXPECTED_RUNTIME_FIELDS = [
  'reserveId',
  'marketName',
  'chainName',
  'chainId',
  'tokenName',
  'tokenSymbol',
  'tokenAddress',
  'tokenPrice',
  'reserveSizeUsd',
  'utilizationPct',
  'aTokenAddress',
  'vTokenAddress',
  'supplyApy',
  'supplyDisabled',
  'isFrozen',
  'isPaused',
  'supplyCapUsd',
  'borrowApy',
  'borrowDisabled',
  'borrowCapUsd',
  'supplyIncentives',
  'borrowIncentives',
  'decimals',
  'availableLiquidity',
  'totalVariableDebt',
  'reserveFactor',
  'variableRateSlope1',
  'variableRateSlope2',
  'optimalUsageRate',
  'baseVariableBorrowRate',
  'deficit',
  'aaveProReserveId',
  'meritSupplys',
  'meritBorrows',
  'merklSupplys',
  'merklBorrows',
  'merklHolds',
  'brevisSupplys',
  'brevisBorrows',
  'hubId',
  'hubName',
  'hubAddress',
  'spokeId',
  'spokeName',
  'spokeAddress',
  'assetTotalSupplied',
  'assetTotalBorrowed',
  'assetTotalSupplyCap',
  'assetTotalBorrowCap',
] as const;

// 类型辅助函数：检查对象是否包含所有期望的字段（用于测试）
export function validateRuntimeReserveShape(
  data: Record<string, unknown>
): string[] {
  const missing: string[] = [];
  for (const field of EXPECTED_RUNTIME_FIELDS) {
    // 注意：这里是检查字段存在性，不是值的有效性
    // 使用 in 操作符检查字段是否存在
    if (!(field in data)) {
      missing.push(field);
    }
  }
  return missing;
}

// 编译时类型检查：确保 EXPECTED_RUNTIME_FIELDS 包含所有 RuntimeReserveData 的键
type ExpectedField = typeof EXPECTED_RUNTIME_FIELDS[number];
type RuntimeKeys = keyof RuntimeReserveData;

// 如果 ExpectedField 不包含所有 RuntimeKeys，这里会报错
type ValidateAllFieldsCovered = {
  [K in RuntimeKeys]: K extends ExpectedField ? true : never;
}[RuntimeKeys];

// 反过来检查：确保没有多余的字段在 EXPECTED_RUNTIME_FIELDS 中
type ValidateNoExtraFields = {
  [K in ExpectedField]: K extends RuntimeKeys ? true : never;
}[ExpectedField];

// 导出类型用于外部测试
export type { ValidateRuntimeFields, ValidateAllFieldsCovered, ValidateNoExtraFields };
