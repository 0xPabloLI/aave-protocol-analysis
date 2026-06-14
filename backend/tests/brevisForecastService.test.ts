import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setBrevisForecastEntries,
  getBrevisForecastItems,
  __resetBrevisForecastForTests,
} from '../src/services/brevisForecastService.js';
import type { RuntimeReserveData } from '../src/services/marketsService.js';

test.beforeEach(() => {
  __resetBrevisForecastForTests();
});

const makeMarket = (brevisSupplys?: any[], brevisBorrows?: any[]): RuntimeReserveData =>
  ({
    reserveId: 'test',
    marketName: 'test',
    chainName: 'test',
    chainId: 1,
    tokenName: 'test',
    tokenSymbol: 'test',
    tokenAddress: '0x0',
    brevisSupplys,
    brevisBorrows,
  }) as RuntimeReserveData;

test('setBrevisForecastEntries → getBrevisForecastItems with endTimestamp from markets', () => {
  const entries = new Map<string, number | undefined>([
    ['1754995104', 9512.5],
    ['999', 100],
  ]);
  setBrevisForecastEntries(entries);

  const markets = [
    makeMarket(
      [{ link: '', breakdowns: [{ campaignApr: 0.01, campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31T00:00:00Z', campaignId: '1754995104' }] }],
      [{ link: '', breakdowns: [{ campaignApr: 0.02, campaignStartedAt: '2025-01-01', campaignEndedAt: '2026-06-30T00:00:00Z', campaignId: '999' }] }],
    ),
  ];

  const items = getBrevisForecastItems(markets);
  assert.equal(items.length, 2);

  const item1 = items.find(i => i.campaignId === '1754995104');
  assert.ok(item1);
  assert.equal(item1.distributedSoFar, 9512.5);
  assert.equal(item1.endTimestamp, Math.floor(new Date('2025-12-31T00:00:00Z').getTime() / 1000));

  const item2 = items.find(i => i.campaignId === '999');
  assert.ok(item2);
  assert.equal(item2.distributedSoFar, 100);
  assert.equal(item2.endTimestamp, Math.floor(new Date('2026-06-30T00:00:00Z').getTime() / 1000));
});

test('undefined values are excluded from items', () => {
  const entries = new Map<string, number | undefined>([
    ['1754995104', 9512.5],
    ['failed-campaign', undefined],
  ]);
  setBrevisForecastEntries(entries);

  const items = getBrevisForecastItems([]);
  assert.equal(items.length, 1);
  assert.equal(items[0].campaignId, '1754995104');
});

test('missing campaignEndedAt produces item without endTimestamp', () => {
  const entries = new Map<string, number | undefined>([
    ['no-end', 50],
  ]);
  setBrevisForecastEntries(entries);

  const markets = [
    makeMarket(
      [{ link: '', breakdowns: [{ campaignApr: 0.01, campaignStartedAt: '2025-01-01', campaignId: 'no-end' }] }],
      [],
    ),
  ];

  const items = getBrevisForecastItems(markets);
  assert.equal(items.length, 1);
  assert.equal(items[0].campaignId, 'no-end');
  assert.equal(items[0].distributedSoFar, 50);
  assert.equal('endTimestamp' in items[0], false);
});

test('empty map produces empty items', () => {
  setBrevisForecastEntries(new Map());
  const items = getBrevisForecastItems([]);
  assert.equal(items.length, 0);
});

test('field name is distributedSoFar (not distributedSoFarUsd)', () => {
  const entries = new Map<string, number | undefined>([
    ['c1', 42],
  ]);
  setBrevisForecastEntries(entries);

  const items = getBrevisForecastItems([]);
  assert.equal(items.length, 1);
  assert.ok('distributedSoFar' in items[0]);
  assert.equal(('distributedSoFarUsd' in items[0]) as boolean, false);
});
