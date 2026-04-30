/**
 * Field Coverage Tests
 * 
 * 确保 pruneReserveForRuntime 不会遗漏任何字段
 */

import test from 'node:test';
import assert from 'node:assert/strict';
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
  reserveFactor: 20,
  variableRateSlope1: 4,
  variableRateSlope2: 80,
  optimalUsageRate: 80,
  baseVariableBorrowRate: 0.4,
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
};

test('all critical fields defined in EXPECTED_RUNTIME_FIELDS', () => {
  const criticalFields = [
    'reserveId',
    'tokenAddress',
    'supplyApy',
    'reserveFactor',
    'variableRateSlope1',
    'variableRateSlope2',
    'optimalUsageRate',
    'baseVariableBorrowRate',
  ];
  
  for (const field of criticalFields) {
    assert(EXPECTED_RUNTIME_FIELDS.includes(field as any), `Missing field: ${field}`);
  }
});

test('detect missing fields in runtime data', () => {
  const incompleteData = {
    reserveId: 'test',
    marketName: 'test',
  };

  const missing = validateRuntimeReserveShape(incompleteData);
  
  assert(missing.length > 0, 'Should detect missing fields');
  assert(missing.includes('tokenAddress'), 'Should detect missing tokenAddress');
  assert(missing.includes('chainId'), 'Should detect missing chainId');
});

test('validate complete mock reserve has no missing fields', () => {
  const missing = validateRuntimeReserveShape(mockFullReserve);
  
  assert.strictEqual(missing.length, 0, `Missing fields: ${missing.join(', ')}`);
});

test('V4 Hub & Spoke addressing fields present in registry', () => {
  const v4Fields = ['hubId', 'hubName', 'hubAddress', 'spokeId', 'spokeName', 'spokeAddress'];

  for (const field of v4Fields) {
    assert(EXPECTED_RUNTIME_FIELDS.includes(field as any), `Missing V4 field: ${field}`);
    assert(field in mockFullReserve, `Field not in mock: ${field}`);
  }
});
