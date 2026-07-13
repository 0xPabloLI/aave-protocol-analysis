import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GscRow } from '../src/services/gscService.js';

function makeGscRow(country: string, page: string, query: string, clicks = 1, impressions = 10, ctr = 0.1, position = 5.0): GscRow {
  return { keys: [country, page, query], clicks, impressions, ctr, position };
}

test('gscFetchState: initial state has nulls and zero', async () => {
  const { getGscFetchState } = await import('../src/services/gscFetchState.js');
  const state = getGscFetchState();
  assert.equal(state.lastSuccessAt, null);
  assert.equal(state.lastTargetDate, null);
  assert.equal(state.lastRowsUpserted, 0);
  assert.equal(state.lastError, null);
});

test('gscFetchState: setGscFetchSuccess updates state', async () => {
  const mod = await import('../src/services/gscFetchState.js');
  mod.setGscFetchSuccess({ targetDate: '2026-05-15', rowsUpserted: 42 });
  const state = mod.getGscFetchState();
  assert.equal(state.lastTargetDate, '2026-05-15');
  assert.equal(state.lastRowsUpserted, 42);
  assert.equal(state.lastError, null);
  assert.ok(state.lastSuccessAt !== null);
});

test('gscFetchState: setGscFetchFailure sets lastError', async () => {
  const mod = await import('../src/services/gscFetchState.js');
  mod.setGscFetchFailure('timeout');
  const state = mod.getGscFetchState();
  assert.equal(state.lastError, 'timeout');
});

test('GscRow structure: keys map to country/page/query', () => {
  const row = makeGscRow('bra', '/supply', 'aave supply');
  assert.equal(row.keys[0], 'bra');
  assert.equal(row.keys[1], '/supply');
  assert.equal(row.keys[2], 'aave supply');
  assert.equal(row.clicks, 1);
  assert.equal(row.impressions, 10);
});
