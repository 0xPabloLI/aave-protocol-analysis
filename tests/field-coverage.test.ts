/**
 * Field Coverage Tests
 * 
 * 确保 pruneReserveForRuntime 不会遗漏任何字段
 */

import { describe, it, expect } from 'vitest';
import { EXPECTED_RUNTIME_FIELDS, validateRuntimeReserveShape } from '../src/types/runtime-validation.js';

// 模拟一个完整的 FormattedReserveData 对象（包含所有可能的字段）
const mockFullReserve = {
  reserveId: 'test-id',
  marketName: 'AaveV3Ethereum',
  chainName: 'Ethereum',
  chainId: 1,
  tokenName: 'USD Coin',
  tokenSymbol: 'USDC',
  tokenAddress: '0xa0b86a33e6773c6d82e7a83b3b93c7e9',
  tokenPrice: 1.0,
  reserveSizeUsd: 1000000,
  utilizationPct: 80,
  aTokenAddress: '0xa0b86a33e6773c6d82e7a83b3b93c7e9',
  vTokenAddress: '0xa0b86a33e6773c6d82e7a83b3b93c7e9',
  supplyApy: 0.05,
  supplyDisabled: false,
  isFrozen: false,
  isPaused: false,
  supplyCapUsd: 10000000,
  borrowApy: 0.08,
  borrowDisabled: false,
  borrowCapUsd: 8000000,
  supplyIncentives: [0.01],
  borrowIncentives: [0.02],
  decimals: 6,
  availableLiquidity: '1000000000000',
  totalVariableDebt: '800000000000',
  reserveFactor: '2000',
  variableRateSlope1: '40000000000000000000000000',
  variableRateSlope2: '800000000000000000000000000',
  optimalUsageRate: '800000000000000000000000000',
  baseVariableBorrowRate: '4000000000000000000000000',
  deficit: '0',
  aaveProReserveId: '12345',
  meritSupplys: [{ apr: 0.01, link: 'test', startDate: '2024-01-01', endDate: '2024-12-31' }],
  meritBorrows: [{ apr: 0.01, link: 'test', startDate: '2024-01-01', endDate: '2024-12-31' }],
  merklSupplys: [{ link: 'test', breakdowns: [] }],
  merklBorrows: [{ link: 'test', breakdowns: [] }],
  merklHolds: [{ link: 'test', breakdowns: [] }],
  brevisSupplys: [{ campaignId: 'test', link: 'test', breakdowns: [] }],
  brevisBorrows: [{ campaignId: 'test', link: 'test', breakdowns: [] }],
  hubId: '1',
  hubName: 'Core',
  hubAddress: '0x1234',
  spokeId: '1',
  spokeName: 'Main',
  spokeAddress: '0x5678',
  assetTotalSupplied: '1000000000000',
  assetTotalBorrowed: '800000000000',
  assetTotalSupplyCap: '10000000000000',
  assetTotalBorrowCap: '8000000000000',
};

describe('RuntimeReserveData Field Coverage', () => {
  it('should have all expected fields defined in EXPECTED_RUNTIME_FIELDS', () => {
    // 验证 EXPECTED_RUNTIME_FIELDS 包含所有关键字段
    const criticalFields = [
      'reserveId',
      'tokenAddress',
      'supplyApy',
      'assetTotalSupplied',
      'assetTotalBorrowed',
      'assetTotalSupplyCap',
      'assetTotalBorrowCap',
    ];
    
    for (const field of criticalFields) {
      expect(EXPECTED_RUNTIME_FIELDS).toContain(field);
    }
  });

  it('should detect missing fields in runtime data', () => {
    // 创建一个缺少某些字段的对象
    const incompleteData = {
      reserveId: 'test',
      marketName: 'test',
      // 缺少很多字段...
    };

    const missing = validateRuntimeReserveShape(incompleteData);
    
    // 应该检测到缺失的字段
    expect(missing.length).toBeGreaterThan(0);
    expect(missing).toContain('tokenAddress');
    expect(missing).toContain('chainId');
  });

  it('should validate complete mock reserve has no missing fields', () => {
    const missing = validateRuntimeReserveShape(mockFullReserve);
    
    // 完整的 mock 数据不应该有缺失字段
    expect(missing).toHaveLength(0);
  });

  it('should specifically check for V4 HubAsset summary fields', () => {
    const v4Fields = [
      'assetTotalSupplied',
      'assetTotalBorrowed', 
      'assetTotalSupplyCap',
      'assetTotalBorrowCap',
    ];

    for (const field of v4Fields) {
      expect(EXPECTED_RUNTIME_FIELDS).toContain(field);
      expect(field in mockFullReserve).toBe(true);
    }
  });
});
