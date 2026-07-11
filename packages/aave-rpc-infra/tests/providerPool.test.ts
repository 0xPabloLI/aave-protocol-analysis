import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderPool } from '../src/index.js';

test('ProviderPool suppresses unhealthy endpoints and keeps them as last resort', () => {
  let now = 1_000;
  const pool = new ProviderPool({
    failureThreshold: 2,
    suppressionMs: 10_000,
    now: () => now,
  });

  const urls = ['https://rpc-a.example', 'https://rpc-b.example'];

  assert.deepEqual(pool.getProvidersForChain(1, urls).map(c => c.rpcUrl), urls);

  pool.reportProviderFailure(1, urls[0], 'first failure');
  assert.deepEqual(pool.getProvidersForChain(1, urls).map(c => c.rpcUrl), urls);

  pool.reportProviderFailure(1, urls[0], 'second failure');
  assert.deepEqual(pool.getProvidersForChain(1, urls).map(c => c.rpcUrl), [urls[1], urls[0]]);

  now += 10_001;
  assert.deepEqual(pool.getProvidersForChain(1, urls).map(c => c.rpcUrl), urls);
});

test('ProviderPool prefers the most recently successful healthy endpoint', () => {
  let now = 1_000;
  const pool = new ProviderPool({ now: () => now });
  const urls = ['https://rpc-a.example', 'https://rpc-b.example'];

  now = 2_000;
  pool.reportProviderSuccess(1, urls[1]);

  assert.deepEqual(pool.getProvidersForChain(1, urls).map(c => c.rpcUrl), [urls[1], urls[0]]);
});
