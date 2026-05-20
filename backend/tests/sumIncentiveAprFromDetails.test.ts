import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sumIncentiveAprFromDetails } from '../src/services/persistenceService.js';
import type { PerCampaignIncentiveDetails } from '../src/services/persistenceService.js';

test('sumIncentiveAprFromDetails: returns null for null/undefined details', () => {
  assert.equal(sumIncentiveAprFromDetails(null, 'supply'), null);
  assert.equal(sumIncentiveAprFromDetails(undefined, 'supply'), null);
});

test('sumIncentiveAprFromDetails: returns null for empty details', () => {
  assert.equal(sumIncentiveAprFromDetails({}, 'supply'), null);
});

test('sumIncentiveAprFromDetails: sums legacy supply', () => {
  const details: PerCampaignIncentiveDetails = {
    legacySupply: [0.01, 0.02],
  };
  assert.equal(sumIncentiveAprFromDetails(details, 'supply'), 3);
});

test('sumIncentiveAprFromDetails: sums legacy borrow', () => {
  const details: PerCampaignIncentiveDetails = {
    legacyBorrow: [0.03],
  };
  assert.equal(sumIncentiveAprFromDetails(details, 'borrow'), 3);
});

test('sumIncentiveAprFromDetails: sums merit supply entries (unexpired only)', () => {
  const now = new Date('2025-06-01T00:00:00Z');
  const details: PerCampaignIncentiveDetails = {
    meritSupplys: [
      { key: 'a', apr: 0.01, endDate: '2025-12-31', link: 'x' },
      { key: 'b', apr: 0.02, endDate: '2025-01-01', link: 'y' },
    ],
  };
  const result = sumIncentiveAprFromDetails(details, 'supply', now);
  assert.equal(result, 1);
});

test('sumIncentiveAprFromDetails: sums merkl supply breakdowns (unexpired only)', () => {
  const now = new Date('2025-06-01T00:00:00Z');
  const details: PerCampaignIncentiveDetails = {
    merklSupplys: [
      {
        groupId: 'g1',
        link: 'l',
        breakdowns: [
          { key: 'k1', apr: 0.01, endDate: '2025-12-31', startDate: '2025-01-01' },
          { key: 'k2', apr: 0.02, endDate: '2025-01-01', startDate: '2024-01-01' },
        ],
      },
    ],
  };
  const result = sumIncentiveAprFromDetails(details, 'supply', now);
  assert.equal(result, 1);
});

test('sumIncentiveAprFromDetails: sums brevis supply breakdowns (unexpired only)', () => {
  const now = new Date('2025-06-01T00:00:00Z');
  const details: PerCampaignIncentiveDetails = {
    brevisSupplys: [
      {
        groupId: 'g1',
        link: 'l',
        breakdowns: [
          { key: 'k1', apr: 0.015, endDate: '2025-12-31', startDate: '2025-01-01' },
        ],
      },
    ],
  };
  const result = sumIncentiveAprFromDetails(details, 'supply', now);
  assert.equal(result, 1.5);
});

test('sumIncentiveAprFromDetails: combines all sources', () => {
  const now = new Date('2025-06-01T00:00:00Z');
  const details: PerCampaignIncentiveDetails = {
    legacySupply: [0.01],
    meritSupplys: [
      { key: 'a', apr: 0.005, endDate: '2025-12-31', link: 'x' },
    ],
    merklSupplys: [
      {
        groupId: 'g1',
        link: 'l',
        breakdowns: [
          { key: 'k1', apr: 0.01, endDate: '2025-12-31', startDate: '2025-01-01' },
        ],
      },
    ],
    brevisSupplys: [
      {
        groupId: 'g2',
        link: 'l2',
        breakdowns: [
          { key: 'k2', apr: 0.005, endDate: '2025-12-31', startDate: '2025-01-01' },
        ],
      },
    ],
  };
  const result = sumIncentiveAprFromDetails(details, 'supply', now);
  assert.equal(result, 3);
});

test('sumIncentiveAprFromDetails: borrow side uses borrow fields', () => {
  const now = new Date('2025-06-01T00:00:00Z');
  const details: PerCampaignIncentiveDetails = {
    legacyBorrow: [0.02],
    meritBorrows: [
      { key: 'a', apr: 0.01, endDate: '2025-12-31', link: 'x' },
    ],
    merklBorrows: [
      {
        groupId: 'g1',
        link: 'l',
        breakdowns: [
          { key: 'k1', apr: 0.02, endDate: '2025-12-31', startDate: '2025-01-01' },
        ],
      },
    ],
    brevisBorrows: [
      {
        groupId: 'g2',
        link: 'l2',
        breakdowns: [
          { key: 'k2', apr: 0.01, endDate: '2025-12-31', startDate: '2025-01-01' },
        ],
      },
    ],
  };
  const result = sumIncentiveAprFromDetails(details, 'borrow', now);
  assert.equal(result, 6);
});

test('sumIncentiveAprFromDetails: all expired returns null', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const details: PerCampaignIncentiveDetails = {
    meritSupplys: [
      { key: 'a', apr: 0.01, endDate: '2025-01-01', link: 'x' },
    ],
    merklSupplys: [
      {
        groupId: 'g1',
        link: 'l',
        breakdowns: [
          { key: 'k1', apr: 0.02, endDate: '2025-01-01', startDate: '2024-01-01' },
        ],
      },
    ],
  };
  assert.equal(sumIncentiveAprFromDetails(details, 'supply', now), null);
});

test('sumIncentiveAprFromDetails: missing endDate treated as unexpired', () => {
  const now = new Date('2025-06-01T00:00:00Z');
  const details: PerCampaignIncentiveDetails = {
    meritSupplys: [
      { key: 'a', apr: 0.01, endDate: '', link: 'x' },
    ],
  };
  const result = sumIncentiveAprFromDetails(details, 'supply', now);
  assert.equal(result, 1);
});

// ── Equivalence test: legacy + merit + merkl + brevis (Task 9.2) ──────────

test('sumIncentiveAprFromDetails: full equivalence across all 4 sources', () => {
  const now = new Date('2025-06-01T00:00:00Z');
  const details: PerCampaignIncentiveDetails = {
    legacySupply: [0.003, 0.002],
    meritSupplys: [
      { key: 'm1', apr: 0.01, endDate: '2025-12-31', link: 'https://m.com/1' },
    ],
    merklSupplys: [
      {
        groupId: 'g1',
        link: 'https://merkl.com/g1',
        breakdowns: [
          { key: 'k1', apr: 0.015, endDate: '2025-12-31', startDate: '2025-01-01' },
        ],
      },
    ],
    brevisSupplys: [
      {
        groupId: 'g2',
        link: 'https://brevis.com/g2',
        breakdowns: [
          { key: 'k2', apr: 0.005, endDate: '2025-12-31', startDate: '2025-01-01' },
        ],
      },
    ],
  };
  const result = sumIncentiveAprFromDetails(details, 'supply', now);
  // (0.003 + 0.002) * 100 + 0.01 * 100 + 0.015 * 100 + 0.005 * 100
  // = 0.5 + 1 + 1.5 + 0.5 = 3.5
  assert.equal(result, 3.5);
});

test('sumIncentiveAprFromDetails: borrow side equivalence across all 4 sources', () => {
  const now = new Date('2025-06-01T00:00:00Z');
  const details: PerCampaignIncentiveDetails = {
    legacyBorrow: [0.004],
    meritBorrows: [
      { key: 'm1', apr: 0.02, endDate: '2025-12-31', link: 'https://m.com/1' },
    ],
    merklBorrows: [
      {
        groupId: 'g1',
        link: 'https://merkl.com/g1',
        breakdowns: [
          { key: 'k1', apr: 0.01, endDate: '2025-12-31', startDate: '2025-01-01' },
        ],
      },
    ],
    brevisBorrows: [
      {
        groupId: 'g2',
        link: 'https://brevis.com/g2',
        breakdowns: [
          { key: 'k2', apr: 0.006, endDate: '2025-12-31', startDate: '2025-01-01' },
        ],
      },
    ],
  };
  const result = sumIncentiveAprFromDetails(details, 'borrow', now);
  // 0.004*100 + 0.02*100 + 0.01*100 + 0.006*100 = 0.4 + 2 + 1 + 0.6 = 4
  assert.equal(result, 4);
});

// ── Performance test: sumIncentiveAprFromDetails < 0.5ms (Task 10.2) ─────

test('sumIncentiveAprFromDetails performance < 0.5ms per call', () => {
  const now = new Date('2025-06-01T00:00:00Z');
  const details: PerCampaignIncentiveDetails = {
    legacySupply: Array.from({ length: 10 }, (_, i) => 0.001 * (i + 1)),
    meritSupplys: Array.from({ length: 20 }, (_, i) => ({
      key: `merit-${i}`, apr: 0.01, endDate: '2025-12-31', link: `https://m.com/${i}`,
    })),
    merklSupplys: Array.from({ length: 10 }, (_, i) => ({
      groupId: `g-${i}`, link: `https://merkl.com/${i}`,
      breakdowns: Array.from({ length: 5 }, (_, j) => ({
        key: `k-${i}-${j}`, apr: 0.01, endDate: '2025-12-31', startDate: '2025-01-01',
      })),
    })),
    brevisSupplys: Array.from({ length: 5 }, (_, i) => ({
      groupId: `bv-${i}`, link: `https://brevis.com/${i}`,
      breakdowns: Array.from({ length: 3 }, (_, j) => ({
        key: `bv-k-${i}-${j}`, apr: 0.01, endDate: '2025-12-31', startDate: '2025-01-01',
      })),
    })),
  };
  const start = performance.now();
  for (let i = 0; i < 1000; i++) sumIncentiveAprFromDetails(details, 'supply', now);
  const avg = (performance.now() - start) / 1000;
  assert.ok(avg < 0.5, `avg=${avg}ms exceeds 0.5ms`);
});
