import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeHash,
  resetPersistenceHashes,
  buildIncentiveDetails,
  buildConfigRow,
} from '../src/services/persistenceService.js';
import type { RuntimeReserveData } from '@internal/aave-shared-contracts';

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
  resetPersistenceHashes();
  assert.ok(computeHash(['test']).length > 0);
});

test('resetPersistenceHashes: resets all three hash maps (snapshots, configs, oracles)', () => {
  const hash1 = computeHash(['snapshot-test']);
  const hash2 = computeHash(['config-test']);
  const hash3 = computeHash(['oracle-test']);

  resetPersistenceHashes();

  assert.ok(computeHash([hash1, hash2, hash3]).length > 0);
});

// ── buildSnapshotRow output verification (Task 9.1) ──────────────────────

test('buildSnapshotRow: supply_incentives_apr position is null (column removed)', () => {
  const MARKET_COLUMNS = [
    'snapshot_ts', 'reserve_id',
    'token_price', 'supply_apy', 'borrow_apy', 'utilization_pct',
    'liquidity', 'borrowed', 'supplied', 'deficit',
    'incentive_details',
  ] as const;
  assert.ok(!MARKET_COLUMNS.includes('supply_incentives_apr' as typeof MARKET_COLUMNS[number]));
  assert.ok(!MARKET_COLUMNS.includes('borrow_incentives_apr' as typeof MARKET_COLUMNS[number]));
});

test('buildSnapshotRow: incentive_details is per-campaign structure (JSON parseable)', () => {
  const r = baseReserve({
    supplyIncentives: [0.01],
    meritSupplys: [{ apr: 0.02, link: 'https://m.com/r1', startDate: '2025-01-01', endDate: '2025-12-31' }] as RuntimeReserveData['meritSupplys'],
  });
  const details = buildIncentiveDetails(r);
  const json = JSON.stringify(details);
  const parsed = JSON.parse(json);
  assert.ok(parsed.legacySupply);
  assert.ok(parsed.meritSupplys);
  assert.equal(parsed.meritSupplys[0].key, 'https://m.com/r1::2025-12-31');
  assert.equal(parsed.meritSupplys[0].apr, 0.02);
});

// ── buildConfigRow: content_hash warm-start dedup ──────────────────────────

test('buildConfigRow: returns { row, hash } with hash as last element of row', () => {
  const r = baseReserve();
  const { row, hash } = buildConfigRow(r, '2026-05-21T00:00:00.000Z');
  assert.equal(typeof hash, 'string');
  assert.ok(hash.length > 0);
  assert.equal(row[row.length - 1], hash, 'hash must be the last element (content_hash column)');
});

test('buildConfigRow: same reserve + same ts → same hash', () => {
  const r = baseReserve();
  const a = buildConfigRow(r, '2026-05-21T00:00:00.000Z');
  const b = buildConfigRow(r, '2026-05-21T00:00:00.000Z');
  assert.equal(a.hash, b.hash);
});

test('buildConfigRow: different reserve data → different hash', () => {
  const r1 = baseReserve();
  const r2 = baseReserve({ tokenSymbol: 'DAI' });
  const a = buildConfigRow(r1, '2026-05-21T00:00:00.000Z');
  const b = buildConfigRow(r2, '2026-05-21T00:00:00.000Z');
  assert.notEqual(a.hash, b.hash);
});

test('buildConfigRow: hash excludes snapshot_ts (only content fields)', () => {
  const r = baseReserve();
  const a = buildConfigRow(r, '2026-05-21T00:00:00.000Z');
  const b = buildConfigRow(r, '2026-05-22T00:00:00.000Z');
  assert.equal(a.hash, b.hash, 'same config content must produce same hash regardless of ts');
});

test('buildConfigRow: row length matches MARKET_CONFIG_COLUMNS count', () => {
  const MARKET_CONFIG_COLUMNS_COUNT = 30;
  const r = baseReserve();
  const { row } = buildConfigRow(r, '2026-05-21T00:00:00.000Z');
  assert.equal(row.length, MARKET_CONFIG_COLUMNS_COUNT, `expected ${MARKET_CONFIG_COLUMNS_COUNT} columns (including content_hash)`);
});
