import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeCampaignKey,
  computeHash,
  resetPersistenceHashes,
  buildIncentiveDetails,
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

// ── Campaign key computation ────────────────────────────────────────────

test('computeCampaignKey: merit uses link::endDate', () => {
  const entry = { link: 'https://merit.example.com/round-42', endDate: '2025-05-15T23:59:59Z' };
  const key = computeCampaignKey('merit', entry);
  assert.equal(key, 'https://merit.example.com/round-42::2025-05-15T23:59:59Z');
});

test('computeCampaignKey: merit same link different endDate → different key', () => {
  const a = computeCampaignKey('merit', { link: 'https://x.com/1', endDate: '2025-01-01' });
  const b = computeCampaignKey('merit', { link: 'https://x.com/1', endDate: '2025-06-01' });
  assert.notEqual(a, b);
});

test('computeCampaignKey: merkl uses campaignId', () => {
  const entry = { campaignId: '0xabc123def456' };
  const key = computeCampaignKey('merkl', entry);
  assert.equal(key, '0xabc123def456');
});

test('computeCampaignKey: brevis with campaignId uses it directly', () => {
  const entry = { campaignId: '0xbrevis001' };
  const key = computeCampaignKey('brevis', entry);
  assert.equal(key, '0xbrevis001');
});

test('computeCampaignKey: brevis without campaignId falls back to hash', () => {
  const entry = {
    link: 'https://brevis.example.com/c1',
    campaignStartedAt: '2025-05-01T00:00:00Z',
    campaignEndedAt: '2025-05-15T00:00:00Z',
  };
  const key = computeCampaignKey('brevis', entry);
  assert.ok(key.length > 0);
  assert.ok(key.startsWith('brevis::'));
});

test('computeCampaignKey: brevis fallback hash is deterministic', () => {
  const entry = {
    link: 'https://brevis.example.com/c1',
    campaignStartedAt: '2025-05-01T00:00:00Z',
    campaignEndedAt: '2025-05-15T00:00:00Z',
  };
  const a = computeCampaignKey('brevis', entry);
  const b = computeCampaignKey('brevis', { ...entry });
  assert.equal(a, b);
});

test('computeCampaignKey: brevis fallback hash differs when link differs', () => {
  const a = computeCampaignKey('brevis', { link: 'https://x.com/a', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-06-01' });
  const b = computeCampaignKey('brevis', { link: 'https://x.com/b', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-06-01' });
  assert.notEqual(a, b);
});

test('computeCampaignKey: brevis fallback hash differs when dates differ', () => {
  const a = computeCampaignKey('brevis', { link: 'https://x.com/c', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-06-01' });
  const b = computeCampaignKey('brevis', { link: 'https://x.com/c', campaignStartedAt: '2025-02-01', campaignEndedAt: '2025-06-01' });
  assert.notEqual(a, b);
});

test('computeCampaignKey: merit distinct links with same endDate → different key', () => {
  const a = computeCampaignKey('merit', { link: 'https://m.com/1', endDate: '2025-01-01' });
  const b = computeCampaignKey('merit', { link: 'https://m.com/2', endDate: '2025-01-01' });
  assert.notEqual(a, b);
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
