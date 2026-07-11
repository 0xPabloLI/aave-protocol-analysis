import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderPool } from '../src/index.js';

test('getHealthStatus: empty pool → all zeros', () => {
  const pool = new ProviderPool();
  const status = pool.getHealthStatus();
  assert.deepEqual(status.summary, { total: 0, healthy: 0, suppressed: 0 });
  assert.equal(status.endpoints.length, 0);
});

test('getHealthStatus: reports healthy endpoint after success', () => {
  const pool = new ProviderPool({ now: () => 1000 });
  pool.reportProviderSuccess(1, 'https://rpc-a.example');

  const status = pool.getHealthStatus();
  assert.deepEqual(status.summary, { total: 1, healthy: 1, suppressed: 0 });
  assert.equal(status.endpoints.length, 1);

  const ep = status.endpoints[0];
  assert.equal(ep.chainId, 1);
  assert.equal(ep.rpcUrl, 'https://rpc-a.example');
  assert.equal(ep.status, 'healthy');
  assert.equal(ep.consecutiveFailures, 0);
  assert.equal(ep.lastError, '');
  assert.equal(ep.lastFailureAt, new Date(0).toISOString());
  assert.equal(ep.lastSuccessAt, new Date(1000).toISOString());
  assert.equal(ep.suppressedUntil, undefined);
});

test('getHealthStatus: reports suppressed endpoint after failures', () => {
  const pool = new ProviderPool({ failureThreshold: 2, suppressionMs: 60_000, now: () => 1000 });
  pool.reportProviderFailure(1, 'https://rpc-a.example', 'err1');
  pool.reportProviderFailure(1, 'https://rpc-a.example', 'err2');

  const status = pool.getHealthStatus();
  assert.deepEqual(status.summary, { total: 1, healthy: 0, suppressed: 1 });

  const ep = status.endpoints[0];
  assert.equal(ep.status, 'suppressed');
  assert.equal(ep.consecutiveFailures, 2);
  assert.equal(ep.lastError, 'err2');
  assert.equal(ep.suppressedUntil, new Date(61_000).toISOString());
});

test('getHealthStatus: mixed healthy and suppressed endpoints', () => {
  const pool = new ProviderPool({ failureThreshold: 1, suppressionMs: 60_000, now: () => 1000 });
  pool.reportProviderSuccess(1, 'https://rpc-healthy.example');
  pool.reportProviderFailure(1, 'https://rpc-bad.example', 'timeout');

  const status = pool.getHealthStatus();
  assert.deepEqual(status.summary, { total: 2, healthy: 1, suppressed: 1 });

  const healthy = status.endpoints.find(e => e.status === 'healthy');
  const suppressed = status.endpoints.find(e => e.status === 'suppressed');
  assert.ok(healthy);
  assert.ok(suppressed);
  assert.equal(healthy.rpcUrl, 'https://rpc-healthy.example');
  assert.equal(suppressed.rpcUrl, 'https://rpc-bad.example');
});

test('getHealthStatus: endpoints sorted by chainId then rpcUrl', () => {
  const pool = new ProviderPool({ now: () => 1000 });
  pool.reportProviderSuccess(10, 'https://rpc-b.example');
  pool.reportProviderSuccess(1, 'https://rpc-a.example');
  pool.reportProviderSuccess(1, 'https://rpc-b.example');

  const status = pool.getHealthStatus();
  assert.equal(status.endpoints[0].chainId, 1);
  assert.equal(status.endpoints[0].rpcUrl, 'https://rpc-a.example');
  assert.equal(status.endpoints[1].chainId, 1);
  assert.equal(status.endpoints[1].rpcUrl, 'https://rpc-b.example');
  assert.equal(status.endpoints[2].chainId, 10);
});
