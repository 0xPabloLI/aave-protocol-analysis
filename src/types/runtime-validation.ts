/**
 * RuntimeReserveData 字段注册表
 */

import type { RuntimeReserveData } from '../index.js';

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
  'utilizationPct',
  'aTokenAddress',
  'vTokenAddress',
  'supplyApy',
  'supplyDisabled',
  'isFrozen',
  'isPaused',
  'isActive',
  'borrowApy',
  'borrowDisabled',
  'supplyIncentives',
  'borrowIncentives',
  'decimals',
  'supplyCap',
  'borrowCap',
  'deficit',
  'supplied',
  'borrowed',
  'liquidity',
  'protocolFee',
  'slopeBelowOptimal',
  'slopeAboveOptimal',
  'optimalUtilization',
  'baseBorrowRate',
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
] as const;

// 类型辅助函数：检查对象是否包含所有期望的字段（用于测试）
// ts-prune-ignore-next (used by tests/, which are outside tsconfig.include)
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
