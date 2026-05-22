import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildIncentiveDetails,
  computeHash,
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

test('buildIncentiveDetails: output contains 9 field keys when all sides populated', () => {
  const r = baseReserve({
    supplyIncentives: [0.01],
    borrowIncentives: [0.02],
    meritSupplys: [{ apr: 0.01, link: 'x', startDate: '2025-01-01', endDate: '2025-12-31' }] as RuntimeReserveData['meritSupplys'],
    meritBorrows: [{ apr: 0.02, link: 'y', startDate: '2025-01-01', endDate: '2025-12-31' }] as RuntimeReserveData['meritBorrows'],
    merklSupplys: [{ link: 'l', breakdowns: [{ campaignApr: 0.01, campaignId: 's1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }] }] as unknown as RuntimeReserveData['merklSupplys'],
    merklBorrows: [{ link: 'l', breakdowns: [{ campaignApr: 0.01, campaignId: 'b1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }] }] as unknown as RuntimeReserveData['merklBorrows'],
    merklHolds: [{ link: 'l', breakdowns: [{ campaignApr: 0.01, campaignId: 'h1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }] }] as unknown as RuntimeReserveData['merklHolds'],
    brevisSupplys: [{ link: 'l', breakdowns: [{ campaignApr: 0.01, campaignId: 'bs1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }] }] as unknown as RuntimeReserveData['brevisSupplys'],
    brevisBorrows: [{ link: 'l', breakdowns: [{ campaignApr: 0.01, campaignId: 'bb1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }] }] as unknown as RuntimeReserveData['brevisBorrows'],
  });
  const details = buildIncentiveDetails(r);
  const keys = Object.keys(details);
  assert.equal(keys.length, 9);
  assert.ok(keys.includes('legacySupply'));
  assert.ok(keys.includes('legacyBorrow'));
  assert.ok(keys.includes('meritSupplys'));
  assert.ok(keys.includes('meritBorrows'));
  assert.ok(keys.includes('merklSupplys'));
  assert.ok(keys.includes('merklBorrows'));
  assert.ok(keys.includes('merklHolds'));
  assert.ok(keys.includes('brevisSupplys'));
  assert.ok(keys.includes('brevisBorrows'));
});

test('buildIncentiveDetails: MeritCampaignEntry structure correct', () => {
  const r = baseReserve({
    meritSupplys: [
      { apr: 0.005, link: 'https://m.com/1', name: 'Round 1', startDate: '2025-01-01', endDate: '2025-06-30' },
    ] as RuntimeReserveData['meritSupplys'],
  });
  const details = buildIncentiveDetails(r);
  const entry = details.meritSupplys?.[0];
  assert.ok(entry);
  assert.equal(typeof entry!.key, 'string');
  assert.ok(entry!.key.length > 0);
  assert.equal(entry!.apr, 0.005);
  assert.equal(entry!.name, 'Round 1');
  assert.equal(entry!.endDate, '2025-06-30');
  assert.equal(entry!.link, 'https://m.com/1');
});

test('buildIncentiveDetails: MerklGroupEntry structure correct', () => {
  const r = baseReserve({
    merklSupplys: [
      {
        link: 'https://merkl.com/g1',
        name: 'Merkl Op',
        message: 'Some msg',
        breakdowns: [
          { campaignApr: 0.01, campaignId: 'id-a', type: 'FIX', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-06-01' },
        ],
      },
    ] as unknown as RuntimeReserveData['merklSupplys'],
  });
  const details = buildIncentiveDetails(r);
  const group = details.merklSupplys?.[0];
  assert.ok(group);
  assert.equal(typeof group!.groupId, 'string');
  assert.ok(group!.groupId.length > 0);
  assert.equal(group!.link, 'https://merkl.com/g1');
  assert.equal(group!.name, 'Merkl Op');
  assert.equal(group!.message, 'Some msg');
  assert.equal(group!.breakdowns.length, 1);
  const bd = group!.breakdowns[0];
  assert.equal(typeof bd.key, 'string');
  assert.equal(bd.apr, 0.01);
  assert.equal(bd.type, 'FIX');
  assert.equal(bd.endDate, '2025-06-01');
  assert.equal(bd.startDate, '2025-01-01');
});

test('buildIncentiveDetails: MerklGroupEntry preserves opportunityType', () => {
  const r = baseReserve({
    merklBorrows: [
      {
        link: 'https://merkl.com/net-borrow',
        name: 'Net Borrow USDe',
        message: 'Users who net borrow...',
        opportunityType: 'AAVE_NET_BORROWING',
        breakdowns: [
          { campaignApr: 0.05, campaignId: 'nb-1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' },
        ],
      },
    ] as unknown as RuntimeReserveData['merklBorrows'],
  });
  const details = buildIncentiveDetails(r);
  const group = details.merklBorrows?.[0];
  assert.ok(group);
  assert.equal(group!.opportunityType, 'AAVE_NET_BORROWING');
});

test('buildIncentiveDetails: MerklGroupEntry without opportunityType is undefined', () => {
  const r = baseReserve({
    merklSupplys: [
      {
        link: 'https://merkl.com/plain',
        breakdowns: [
          { campaignApr: 0.03, campaignId: 'p-1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' },
        ],
      },
    ] as unknown as RuntimeReserveData['merklSupplys'],
  });
  const details = buildIncentiveDetails(r);
  const group = details.merklSupplys?.[0];
  assert.ok(group);
  assert.equal(group!.opportunityType, undefined);
});

test('buildIncentiveDetails: BrevisGroupEntry structure correct', () => {
  const r = baseReserve({
    brevisSupplys: [
      {
        link: 'https://brevis.com/g1',
        breakdowns: [
          { campaignApr: 0.02, campaignId: 'bv-a', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-06-01' },
        ],
      },
    ] as unknown as RuntimeReserveData['brevisSupplys'],
  });
  const details = buildIncentiveDetails(r);
  const group = details.brevisSupplys?.[0];
  assert.ok(group);
  assert.equal(typeof group!.groupId, 'string');
  assert.ok(group!.groupId.length > 0);
  assert.equal(group!.link, 'https://brevis.com/g1');
  assert.equal(group!.breakdowns.length, 1);
  const bd = group!.breakdowns[0];
  assert.equal(typeof bd.key, 'string');
  assert.equal(bd.apr, 0.02);
  assert.equal(bd.startDate, '2025-01-01');
  assert.equal(bd.endDate, '2025-06-01');
});

test('buildIncentiveDetails: legacy fields preserved', () => {
  const r = baseReserve({
    supplyIncentives: [0.01, 0.02],
    borrowIncentives: [0.03],
  });
  const details = buildIncentiveDetails(r);
  assert.deepEqual(details.legacySupply, [0.01, 0.02]);
  assert.deepEqual(details.legacyBorrow, [0.03]);
});

test('buildIncentiveDetails: merit entry with missing key fields is skipped', () => {
  const r = baseReserve({
    meritSupplys: [
      { apr: 0.01, link: '', endDate: '', startDate: '2025-01-01' },
    ] as unknown as RuntimeReserveData['meritSupplys'],
  });
  const details = buildIncentiveDetails(r);
  assert.equal(details.meritSupplys?.length ?? 0, 0);
});

test('buildIncentiveDetails: empty reserve produces minimal output', () => {
  const details = buildIncentiveDetails(baseReserve());
  assert.deepEqual(details, {});
});

// ── Performance test: buildIncentiveDetails < 1ms (Task 10.1) ──────────────────

// ── Performance test: buildIncentiveDetails < 1ms (Task 10.1) ────────────

test('buildIncentiveDetails performance < 1ms per reserve', () => {
  const r = baseReserve({
    supplyIncentives: Array.from({ length: 10 }, (_, i) => 0.001 * (i + 1)),
    borrowIncentives: Array.from({ length: 10 }, (_, i) => 0.001 * (i + 1)),
    meritSupplys: Array.from({ length: 20 }, (_, i) => ({
      apr: 0.01, link: `https://m.com/s/${i}`, startDate: '2025-01-01', endDate: '2025-12-31',
    })) as RuntimeReserveData['meritSupplys'],
    meritBorrows: Array.from({ length: 20 }, (_, i) => ({
      apr: 0.01, link: `https://m.com/b/${i}`, startDate: '2025-01-01', endDate: '2025-12-31',
    })) as RuntimeReserveData['meritBorrows'],
    merklSupplys: Array.from({ length: 10 }, (_, i) => ({
      link: `https://merkl.com/s/${i}`,
      breakdowns: Array.from({ length: 5 }, (_, j) => ({
        campaignApr: 0.01, campaignId: `s-${i}-${j}`, campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31',
      })),
    })) as unknown as RuntimeReserveData['merklSupplys'],
    brevisSupplys: Array.from({ length: 5 }, (_, i) => ({
      link: `https://brevis.com/s/${i}`,
      breakdowns: Array.from({ length: 3 }, (_, j) => ({
        campaignApr: 0.01, campaignId: `bv-s-${i}-${j}`, campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31',
      })),
    })) as unknown as RuntimeReserveData['brevisSupplys'],
  });
  const start = performance.now();
  for (let i = 0; i < 1000; i++) buildIncentiveDetails(r);
  const avg = (performance.now() - start) / 1000;
  assert.ok(avg < 1, `avg=${avg}ms exceeds 1ms`);
});

// ── Change-detection hash correctness (Task 10.3) ────────────────────────

test('buildIncentiveDetails: hash differentiates distinct incentive data', () => {
  const r1 = baseReserve({
    meritSupplys: [{ apr: 0.01, link: 'https://m.com/1', startDate: '2025-01-01', endDate: '2025-12-31' }] as RuntimeReserveData['meritSupplys'],
  });
  const r2 = baseReserve({
    meritSupplys: [{ apr: 0.02, link: 'https://m.com/1', startDate: '2025-01-01', endDate: '2025-12-31' }] as RuntimeReserveData['meritSupplys'],
  });
  const h1 = computeHash([buildIncentiveDetails(r1)]);
  const h2 = computeHash([buildIncentiveDetails(r2)]);
  assert.notEqual(h1, h2, 'different incentive data must produce different hashes');
});

test('buildIncentiveDetails: hash stable for identical incentive data', () => {
  const r = baseReserve({
    meritSupplys: [{ apr: 0.01, link: 'https://m.com/1', startDate: '2025-01-01', endDate: '2025-12-31' }] as RuntimeReserveData['meritSupplys'],
  });
  const h1 = computeHash([buildIncentiveDetails(r)]);
  const h2 = computeHash([buildIncentiveDetails(r)]);
  assert.equal(h1, h2, 'same data must produce same hash');
});
