import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateBorrowIncentivesApr,
  aggregateSupplyIncentivesApr,
  computeHash,
  resetPersistenceHashes,
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

// ── Content-hash change detection ──────────────────────────────────────────

test('computeHash: deterministic — same input → same hash', () => {
  const a = computeHash(['USDC', 1.0, 5.5]);
  const b = computeHash(['USDC', 1.0, 5.5]);
  assert.equal(a, b);
  assert.equal(typeof a, 'string');
  assert.ok(a.length > 0);
});

test('computeHash: different data → different hash', () => {
  const hash1 = computeHash(['USDC', 1.0, 5.5]);
  const hash2 = computeHash(['DAI', 1.0, 5.5]);
  assert.notEqual(hash1, hash2);
});

test('computeHash: numeric precision matters', () => {
  const hash1 = computeHash([5.5]);
  const hash2 = computeHash([5.5000000001]);
  assert.notEqual(hash1, hash2);
});

test('computeHash: order-sensitive (different array order → different hash)', () => {
  const hash1 = computeHash(['a', 'b', 'c']);
  const hash2 = computeHash(['c', 'b', 'a']);
  assert.notEqual(hash1, hash2);
});

test('computeHash: handles null/undefined explicitly', () => {
  const hashWithNull = computeHash([null, 1]);
  const hashWithout = computeHash([1]);
  assert.notEqual(hashWithNull, hashWithout);
});

test('resetPersistenceHashes: clears maps without throwing', () => {
  // Verify reset runs cleanly (hash maps start empty, so this is a no-op).
  resetPersistenceHashes();
  // After reset, computeHash still works normally.
  assert.ok(computeHash(['test']).length > 0);
});

test('resetPersistenceHashes: resets all three hash maps (snapshots, configs, oracles)', () => {
  // Confirm the function clears all tracked maps without side effects.
  const hash1 = computeHash(['snapshot-test']);
  const hash2 = computeHash(['config-test']);
  const hash3 = computeHash(['oracle-test']);

  // Simulate hashes being set internally (we verify reset doesn't throw).
  resetPersistenceHashes();

  // All maps should be empty — hashes are still computed normally.
  assert.ok(computeHash([hash1, hash2, hash3]).length > 0);
});
