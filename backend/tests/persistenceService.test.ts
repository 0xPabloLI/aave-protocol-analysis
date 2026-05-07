import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateBorrowIncentivesApr,
  aggregateSupplyIncentivesApr,
} from '../src/services/persistenceService.js';
import type { RuntimeReserveData } from '../../dist/index.js';

function baseReserve(overrides: Partial<RuntimeReserveData> = {}): RuntimeReserveData {
  return {
    reserveId: 'Aave V3:1:0xdead',
    marketName: 'Aave V3',
    chainName: 'Ethereum',
    chainId: 1,
    tokenName: 'USD Coin',
    tokenSymbol: 'USDC',
    tokenAddress: '0xdead',
    ...overrides,
  };
}

test('aggregateSupplyIncentivesApr: returns null when no incentives present', () => {
  assert.equal(aggregateSupplyIncentivesApr(baseReserve()), null);
});

test('aggregateSupplyIncentivesApr: legacy number[] is treated as ratios → percent', () => {
  const r = baseReserve({ supplyIncentives: [0.01, 0.02] }); // 1% + 2%
  assert.equal(aggregateSupplyIncentivesApr(r), 3);
});

test('aggregateSupplyIncentivesApr: sums merit + merkl + brevis (apr ratios → percent)', () => {
  const r = baseReserve({
    meritSupplys: [{ apr: 0.005 }] as RuntimeReserveData['meritSupplys'],
    merklSupplys: [
      { breakdowns: [{ campaignApr: 0.01 }, { campaignApr: 0.02 }] },
    ] as unknown as RuntimeReserveData['merklSupplys'],
    brevisSupplys: [
      { breakdowns: [{ campaignApr: 0.005 }] },
    ] as unknown as RuntimeReserveData['brevisSupplys'],
  });
  // (0.005 + 0.01 + 0.02 + 0.005) * 100 = 4
  assert.equal(aggregateSupplyIncentivesApr(r), 4);
});

test('aggregateBorrowIncentivesApr: ignores non-finite apr values', () => {
  const r = baseReserve({
    borrowIncentives: [Number.NaN, 0.03],
    meritBorrows: [{ apr: Number.POSITIVE_INFINITY }, { apr: 0.01 }] as RuntimeReserveData['meritBorrows'],
  });
  // 0.03 * 100 + 0.01 * 100 = 4
  assert.equal(aggregateBorrowIncentivesApr(r), 4);
});

test('aggregateSupplyIncentivesApr: returns null when only non-finite values', () => {
  const r = baseReserve({ supplyIncentives: [Number.NaN] });
  assert.equal(aggregateSupplyIncentivesApr(r), null);
});
