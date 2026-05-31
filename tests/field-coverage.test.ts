/**
 * Field Coverage Tests
 * 
 * 确保 pruneReserveForRuntime 不会遗漏任何字段
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPECTED_RUNTIME_FIELDS, validateRuntimeReserveShape } from '@internal/aave-shared-contracts';

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
  utilizationPct: 80,
  aTokenAddress: '0xa0b86a33e6773c6d82e7a83b3b93c7e9',
  vTokenAddress: '0xa0b86a33e6773c6d82e7a83b3b93c7e9',
  supplyApy: 0.05,
  supplyDisabled: false,
  isFrozen: false,
  isPaused: false,
  isActive: false,
  borrowApy: 0.08,
  borrowDisabled: false,
  supplyIncentives: [0.01],
  borrowIncentives: [0.02],
  decimals: 6,
  supplyCap: '10000000000000',
  borrowCap: '8000000000000',
  deficit: '0',
  // 字段重命名后仅保留新字段名
  supplied: '1800000000000',
  borrowed: '800000000000',
  liquidity: '1000000000000',
  protocolFee: 20,
  slopeBelowOptimal: 4,
  slopeAboveOptimal: 80,
  optimalUtilization: 80,
  baseBorrowRate: 0.4,
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
  collateralRisk: 5,
};

test('all critical fields defined in EXPECTED_RUNTIME_FIELDS', () => {
  const criticalFields = [
    'reserveId',
    'tokenAddress',
    'supplyApy',
    'protocolFee',
    'slopeBelowOptimal',
    'slopeAboveOptimal',
    'optimalUtilization',
    'baseBorrowRate',
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

// --- 字段重命名完成（Phase 2）：旧字段名已移除，仅保留新字段名 ---

const FIELD_RENAME_MAP: Record<string, string> = {
  reserveSize: 'supplied',
  totalVariableDebt: 'borrowed',
  availableLiquidity: 'liquidity',
  reserveFactor: 'protocolFee',
  variableRateSlope1: 'slopeBelowOptimal',
  variableRateSlope2: 'slopeAboveOptimal',
  optimalUsageRate: 'optimalUtilization',
  baseVariableBorrowRate: 'baseBorrowRate',
};

const OLD_FIELD_NAMES = Object.keys(FIELD_RENAME_MAP);
const NEW_FIELD_NAMES = Object.values(FIELD_RENAME_MAP);

test('Phase 2: new field names registered in EXPECTED_RUNTIME_FIELDS', () => {
  const missing: string[] = [];
  for (const newName of Object.values(FIELD_RENAME_MAP)) {
    if (!EXPECTED_RUNTIME_FIELDS.includes(newName as any)) {
      missing.push(newName);
    }
  }
  assert.strictEqual(missing.length, 0, `New field names not in registry: ${missing.join(', ')}`);
});

test('Phase 2: old field names removed from EXPECTED_RUNTIME_FIELDS', () => {
  const stillPresent: string[] = [];
  for (const oldName of OLD_FIELD_NAMES) {
    if (EXPECTED_RUNTIME_FIELDS.includes(oldName as any)) {
      stillPresent.push(oldName);
    }
  }
  assert.strictEqual(stillPresent.length, 0, `Old field names still in registry: ${stillPresent.join(', ')}`);
});

test('Phase 2: new field names present in mock reserve', () => {
  const missing: string[] = [];
  for (const newName of NEW_FIELD_NAMES) {
    if (!(newName in mockFullReserve)) {
      missing.push(newName);
    }
  }
  assert.strictEqual(missing.length, 0, `New fields missing from mock: ${missing.join(', ')}`);
});

test('Phase 2: old field names removed from mock reserve', () => {
  const stillPresent: string[] = [];
  for (const oldName of OLD_FIELD_NAMES) {
    if (oldName in mockFullReserve) {
      stillPresent.push(oldName);
    }
  }
  assert.strictEqual(stillPresent.length, 0, `Old field names still in mock: ${stillPresent.join(', ')}`);
});
