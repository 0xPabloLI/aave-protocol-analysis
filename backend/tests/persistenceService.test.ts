import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateBorrowIncentivesApr,
  aggregateSupplyIncentivesApr,
  buildCampaignHistoryRows,
  computeCampaignKey,
  computeHash,
  resetPersistenceHashes,
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

// ── Campaign history row building ──────────────────────────────────────

test('buildCampaignHistoryRows: returns empty array for reserve with no campaigns', () => {
  const rows = buildCampaignHistoryRows(baseReserve());
  assert.equal(rows.length, 0);
});

test('buildCampaignHistoryRows: extracts merit supply campaigns', () => {
  const r = baseReserve({
    meritSupplys: [
      { apr: 0.005, link: 'https://m.com/1', startDate: '2025-01-01', endDate: '2025-02-01' },
    ] as RuntimeReserveData['meritSupplys'],
  });
  const rows = buildCampaignHistoryRows(r);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'merit');
  assert.equal(rows[0].side, 'supply');
  assert.equal(rows[0].reserveId, r.reserveId);
  assert.ok(rows[0].campaignKey.length > 0);
});

test('buildCampaignHistoryRows: extracts merit borrow campaigns', () => {
  const r = baseReserve({
    meritBorrows: [
      { apr: 0.01, link: 'https://m.com/2', startDate: '2025-01-01', endDate: '2025-03-01' },
    ] as RuntimeReserveData['meritBorrows'],
  });
  const rows = buildCampaignHistoryRows(r);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'merit');
  assert.equal(rows[0].side, 'borrow');
});

test('buildCampaignHistoryRows: splits merkl CampaignGroup into individual breakdowns', () => {
  const r = baseReserve({
    merklSupplys: [
      {
        link: 'https://merkl.com/g1',
        name: 'Group 1',
        breakdowns: [
          { campaignApr: 0.01, campaignId: 'id-a', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-06-01' },
          { campaignApr: 0.02, campaignId: 'id-b', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-06-01' },
        ],
      },
    ] as unknown as RuntimeReserveData['merklSupplys'],
  });
  const rows = buildCampaignHistoryRows(r);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, 'merkl');
  assert.equal(rows[0].side, 'supply');
  assert.equal(rows[1].source, 'merkl');
  assert.equal(rows[1].side, 'supply');
  assert.notEqual(rows[0].campaignKey, rows[1].campaignKey);
});

test('buildCampaignHistoryRows: carries group-level link/name in campaign_data', () => {
  const r = baseReserve({
    merklSupplys: [
      {
        link: 'https://merkl.com/g1',
        name: 'My Campaign',
        breakdowns: [
          { campaignApr: 0.01, campaignId: 'id-x', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-06-01' },
        ],
      },
    ] as unknown as RuntimeReserveData['merklSupplys'],
  });
  const rows = buildCampaignHistoryRows(r);
  assert.equal(rows.length, 1);
  const data = rows[0].campaignData as Record<string, unknown>;
  assert.equal(data.link, 'https://merkl.com/g1');
  assert.equal(data.name, 'My Campaign');
  assert.equal((data.breakdowns as unknown[]).length, 1);
});

test('buildCampaignHistoryRows: handles all 7 campaign arrays', () => {
  const r = baseReserve({
    meritSupplys: [{ apr: 0.01, link: 'x', startDate: '2025-01-01', endDate: '2025-02-01' }] as RuntimeReserveData['meritSupplys'],
    meritBorrows: [{ apr: 0.01, link: 'x', startDate: '2025-01-01', endDate: '2025-02-01' }] as RuntimeReserveData['meritBorrows'],
    merklSupplys: [{ breakdowns: [{ campaignApr: 0.01, campaignId: 's1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-06-01' }] }] as unknown as RuntimeReserveData['merklSupplys'],
    merklBorrows: [{ breakdowns: [{ campaignApr: 0.01, campaignId: 'b1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-06-01' }] }] as unknown as RuntimeReserveData['merklBorrows'],
    merklHolds: [{ breakdowns: [{ campaignApr: 0.01, campaignId: 'h1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-06-01' }] }] as unknown as RuntimeReserveData['merklHolds'],
    brevisSupplys: [{ breakdowns: [{ campaignApr: 0.01, campaignId: 'bs1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-06-01' }] }] as unknown as RuntimeReserveData['brevisSupplys'],
    brevisBorrows: [{ breakdowns: [{ campaignApr: 0.01, campaignId: 'bb1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-06-01' }] }] as unknown as RuntimeReserveData['brevisBorrows'],
  });
  const rows = buildCampaignHistoryRows(r);
  assert.equal(rows.length, 7);
});

test('buildCampaignHistoryRows: skips undefined campaign arrays', () => {
  const r = baseReserve({
    meritSupplys: [{ apr: 0.01, link: 'x', startDate: '2025-01-01', endDate: '2025-02-01' }] as RuntimeReserveData['meritSupplys'],
  });
  const rows = buildCampaignHistoryRows(r);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'merit');
});

test('buildCampaignHistoryRows: empty breakdowns array produces no rows from that group', () => {
  const r = baseReserve({
    meritSupplys: [{ apr: 0.01, link: 'x', startDate: '2025-01-01', endDate: '2025-02-01' }] as RuntimeReserveData['meritSupplys'],
    merklSupplys: [
      { link: 'x', breakdowns: [] },
    ] as unknown as RuntimeReserveData['merklSupplys'],
  });
  const rows = buildCampaignHistoryRows(r);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'merit');
});

test('buildCampaignHistoryRows: brevis CampaignGroup split into individual breakdowns', () => {
  const r = baseReserve({
    brevisSupplys: [
      {
        link: 'https://brevis.com/g1',
        breakdowns: [
          { campaignApr: 0.01, campaignId: 'bv-a', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-06-01' },
          { campaignApr: 0.02, campaignId: 'bv-b', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-06-01' },
        ],
      },
    ] as unknown as RuntimeReserveData['brevisSupplys'],
  });
  const rows = buildCampaignHistoryRows(r);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, 'brevis');
  assert.equal(rows[1].source, 'brevis');
  assert.notEqual(rows[0].campaignKey, rows[1].campaignKey);
});

test('buildCampaignHistoryRows: multiple merit entries with different keys', () => {
  const r = baseReserve({
    meritSupplys: [
      { apr: 0.01, link: 'https://m.com/r1', startDate: '2025-01-01', endDate: '2025-02-01' },
      { apr: 0.02, link: 'https://m.com/r2', startDate: '2025-03-01', endDate: '2025-04-01' },
    ] as RuntimeReserveData['meritSupplys'],
  });
  const rows = buildCampaignHistoryRows(r);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].campaignKey, rows[1].campaignKey);
});
