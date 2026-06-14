import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setBrevisForecastEntries,
  getBrevisForecastSnapshot,
  __resetBrevisForecastForTests,
} from '../src/services/brevisForecastService.js';

test.beforeEach(() => {
  __resetBrevisForecastForTests();
});

test('setBrevisForecastEntries → getBrevisForecastSnapshot round-trip', () => {
  const entries = new Map<string, number | undefined>([
    ['1754995104', 9512.5],
    ['999', 100],
  ]);
  setBrevisForecastEntries(entries);

  const snapshot = getBrevisForecastSnapshot();
  assert.equal(snapshot.items.length, 2);
  assert.equal(snapshot.items[0].campaignId, '1754995104');
  assert.equal(snapshot.items[0].distributedSoFarUsd, 9512.5);
  assert.equal(snapshot.items[1].campaignId, '999');
  assert.equal(snapshot.items[1].distributedSoFarUsd, 100);
  assert.equal(snapshot.staleTimeMs, 60_000);
});

test('undefined values are excluded from snapshot items', () => {
  const entries = new Map<string, number | undefined>([
    ['1754995104', 9512.5],
    ['failed-campaign', undefined],
  ]);
  setBrevisForecastEntries(entries);

  const snapshot = getBrevisForecastSnapshot();
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].campaignId, '1754995104');
});

test('empty map produces empty items', () => {
  setBrevisForecastEntries(new Map());

  const snapshot = getBrevisForecastSnapshot();
  assert.equal(snapshot.items.length, 0);
  assert.equal(snapshot.staleTimeMs, 60_000);
});
