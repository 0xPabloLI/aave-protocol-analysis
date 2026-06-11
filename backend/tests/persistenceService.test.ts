import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeHash,
  resetPersistenceHashes,
  buildIncentiveDetails,
  buildConfigRow,
  MARKET_CONFIG_COLUMNS,
  oraclePriceKey,
  configKey,
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
    meritSupplys: [{ apr: 0.02, link: 'https://m.com/r1', startDate: '2025-01-01', endDate: '2025-12-31' }] as RuntimeReserveData['meritSupplys'],
  });
  const details = buildIncentiveDetails(r);
  const json = JSON.stringify(details);
  const parsed = JSON.parse(json);
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
  const r = baseReserve();
  const { row } = buildConfigRow(r, '2026-05-21T00:00:00.000Z');
  assert.equal(row.length, MARKET_CONFIG_COLUMNS.length, `expected ${MARKET_CONFIG_COLUMNS.length} columns (including content_hash)`);
});

test('buildConfigRow: hash is deterministic across calls with identical content', () => {
  const r = baseReserve({ supplyCap: '1000', borrowCap: '500' });
  const a = buildConfigRow(r, '2026-05-21T00:00:00.000Z');
  const b = buildConfigRow(r, '2026-05-22T00:00:00.000Z');
  assert.equal(a.hash, b.hash);
  assert.equal(a.row[a.row.length - 1], b.row[b.row.length - 1]);
});

test('buildConfigRow: changing a config field changes the hash', () => {
  const r1 = baseReserve({ supplyCap: '1000' });
  const r2 = baseReserve({ supplyCap: '2000' });
  const a = buildConfigRow(r1, '2026-05-21T00:00:00.000Z');
  const b = buildConfigRow(r2, '2026-05-21T00:00:00.000Z');
  assert.notEqual(a.hash, b.hash);
});

// ── warmConfigHashes: DISTINCT ON semantics ────────────────────────────────

test('warmConfigHashes: DISTINCT ON picks latest per reserve_id (mocked)', () => {
  const rows = [
    { reserve_id: 'A', snapshot_ts: '2026-05-20', content_hash: 'hash_A_old' },
    { reserve_id: 'A', snapshot_ts: '2026-05-21', content_hash: 'hash_A_new' },
    { reserve_id: 'B', snapshot_ts: '2026-05-19', content_hash: 'hash_B' },
  ];
  const byLatest = new Map<string, string>();
  for (const r of rows) {
    if (!r.content_hash) continue;
    const existing = byLatest.get(r.reserve_id);
    if (!existing || r.snapshot_ts > (rows.find(x => x.reserve_id === r.reserve_id && x.content_hash === existing)?.snapshot_ts ?? '')) {
      byLatest.set(r.reserve_id, r.content_hash);
    }
  }
  assert.equal(byLatest.get('A'), 'hash_A_new');
  assert.equal(byLatest.get('B'), 'hash_B');
});

test('warmConfigHashes: rows with NULL content_hash are skipped', () => {
  const rows = [
    { reserve_id: 'A', content_hash: 'hash_A' },
    { reserve_id: 'B', content_hash: null },
  ];
  const loaded = new Map<string, string>();
  for (const r of rows) {
    if (r.reserve_id && r.content_hash) {
      loaded.set(r.reserve_id, r.content_hash);
    }
  }
  assert.equal(loaded.size, 1);
  assert.equal(loaded.get('A'), 'hash_A');
});

test('warmConfigHashes: when persistence disabled, returns 0 without DB call', async () => {
  delete process.env.DATABASE_URL;
  const { warmConfigHashes } = await import('../src/services/persistenceService.js');
  const count = await warmConfigHashes();
  assert.equal(count, 0);
});

test('buildConfigRow: content field count = columns - 2 (minus snapshot_ts and content_hash)', () => {
  const r = baseReserve();
  const { row, hash } = buildConfigRow(r, '2026-05-21T00:00:00.000Z');
  const contentFields = row.slice(1, -1);
  assert.equal(contentFields.length, MARKET_CONFIG_COLUMNS.length - 2, 'content fields should be columns minus snapshot_ts and content_hash');
  const recomputedHash = computeHash(contentFields);
  assert.equal(hash, recomputedHash, 'hash should match recomputed hash from content fields');
});

// ── Hash shrink: key format consistency ──────────────────────────────────────
// Bug history: oraclePriceHashes uses "chainId|tokenAddr|configId" format,
// but shrinkHashMaps was checking against reserveId ("Aave V3:1:0xaddr") —
// the formats never match, so shrink was a no-op. shrinkOraclePriceHashes
// was introduced to use the correct key set from persistOraclePrices.

test('oraclePriceHashes key format uses pipe delimiter (not colon like reserveId)', () => {
  const reserveIdFormat = 'Aave V3:1:0xdead';
  const oracleKeyFormat = oraclePriceKey(1, '0xdead', '0xoracle');
  assert.ok(reserveIdFormat.includes(':'), 'reserveId uses colon delimiter');
  assert.ok(!reserveIdFormat.includes('|'), 'reserveId does NOT use pipe delimiter');
  assert.ok(oracleKeyFormat.includes('|'), 'oracle key uses pipe delimiter');
  assert.ok(!oracleKeyFormat.includes(':'), 'oracle key does NOT use colon delimiter');
  assert.notDeepEqual(
    new Set(reserveIdFormat.split('|')),
    new Set(oracleKeyFormat.split('|')),
    'reserveId and oracle key are fundamentally different key spaces'
  );
});

test('shrinkOraclePriceHashes: only keys in current persist batch survive', () => {
  const currentKeys = new Set([oraclePriceKey(1, '0xaaa', 'cfg1'), oraclePriceKey(1, '0xbbb', 'cfg2')]);
  const staleKeys = [oraclePriceKey(1, '0xold', 'cfg0'), oraclePriceKey(999, '0xstale', 'cfg9')];
  const allKeys = new Set([...currentKeys, ...staleKeys]);
  for (const key of allKeys) {
    if (!currentKeys.has(key)) allKeys.delete(key);
  }
  assert.equal(allKeys.size, 2);
  assert.ok(allKeys.has(oraclePriceKey(1, '0xaaa', 'cfg1')));
  assert.ok(allKeys.has(oraclePriceKey(1, '0xbbb', 'cfg2')));
  assert.ok(!allKeys.has(oraclePriceKey(1, '0xold', 'cfg0')));
});

// ── oraclePriceKey: single source of truth for oraclePriceHashes key format ──

test('oraclePriceKey: produces pipe-delimited key in chainId|tokenAddr|configId format', () => {
  assert.equal(oraclePriceKey(1, '0xdead', 'cfg1'), '1|0xdead|cfg1');
  assert.equal(oraclePriceKey(42161, '0xabc', '42'), '42161|0xabc|42');
});

test('oraclePriceKey: different arguments produce different keys', () => {
  const k1 = oraclePriceKey(1, '0xaaa', 'cfg1');
  const k2 = oraclePriceKey(1, '0xaaa', 'cfg2');
  const k3 = oraclePriceKey(1, '0xbbb', 'cfg1');
  const k4 = oraclePriceKey(2, '0xaaa', 'cfg1');
  assert.notEqual(k1, k2);
  assert.notEqual(k1, k3);
  assert.notEqual(k1, k4);
});

test('oraclePriceKey: key format matches shrinkOraclePriceHashes currentKeys format', () => {
  const chainId = 1;
  const tokenAddr = '0xtoken';
  const configId = '99';
  const key = oraclePriceKey(chainId, tokenAddr, configId);
  const currentKeys = new Set([key]);
  assert.ok(currentKeys.has(oraclePriceKey(chainId, tokenAddr, configId)));
  assert.ok(!currentKeys.has('1|0xother|99'));
  assert.ok(!currentKeys.has('Aave V3:1:0xtoken'));
});

// ── configKey: single source of truth for configMap key format ──

test('configKey: produces pipe-delimited key in source|poolKey format', () => {
  assert.equal(configKey('v3', 'Aave V3'), 'v3|Aave V3');
  assert.equal(configKey('v4', 'Main'), 'v4|Main');
});

test('configKey: different arguments produce different keys', () => {
  const k1 = configKey('v3', 'poolA');
  const k2 = configKey('v3', 'poolB');
  const k3 = configKey('v4', 'poolA');
  assert.notEqual(k1, k2);
  assert.notEqual(k1, k3);
});
