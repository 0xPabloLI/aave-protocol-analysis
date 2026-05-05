/**
 * Prune Function Type Safety Helpers
 * 
 * 这些类型工具确保 pruneReserveForRuntime 函数处理所有 RuntimeReserveData 字段
 */

import type { FormattedReserveData, RuntimeReserveData } from '../index.js';

// ts-prune-ignore-next (compile-time type assertion for field coverage validation)
export type ValidateSourceCoverage = {
  [K in keyof Omit<RuntimeReserveData, 'deficit'>]: 
    K extends keyof FormattedReserveData 
      ? FormattedReserveData[K] extends RuntimeReserveData[K] ? true : never
      : never;
};
