import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderPool } from '../src/index.js';

test('logFn: healthy → suppressed emits warn', () => {
  const logs: Array<{ level: string; msg: string; meta: Record<string, unknown> }> = [];
  const pool = new ProviderPool({
    failureThreshold: 2,
    suppressionMs: 60_000,
    now: () => 1000,
    logFn: (level, msg, meta) => logs.push({ level, msg, meta }),
  });

  // First failure: below threshold, no log
  pool.reportProviderFailure(1, 'https://rpc-a.example', 'ECONNRESET');
  assert.equal(logs.length, 0, 'no log on first failure');

  // Second failure: reaches threshold → suppressed → warn log
  pool.reportProviderFailure(1, 'https://rpc-a.example', 'ECONNRESET again');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'warn');
  assert.equal(logs[0].msg, 'rpc-endpoint-suppressed');
  assert.equal(logs[0].meta.chainId, 1);
  assert.equal(logs[0].meta.rpcUrl, 'https://rpc-a.example');
  assert.equal(logs[0].meta.consecutiveFailures, 2);
  assert.equal(logs[0].meta.lastError, 'ECONNRESET again');
  assert.equal(logs[0].meta.suppressedUntil, 61_000);
});

test('logFn: suppressed → healthy emits info', () => {
  const logs: Array<{ level: string; msg: string; meta: Record<string, unknown> }> = [];
  const pool = new ProviderPool({
    failureThreshold: 1,
    suppressionMs: 60_000,
    now: () => 1000,
    logFn: (level, msg, meta) => logs.push({ level, msg, meta }),
  });

  // Suppress the endpoint
  pool.reportProviderFailure(1, 'https://rpc-a.example', 'ECONNRESET');
  assert.equal(logs.length, 1, 'suppression logged');

  // Recovery
  pool.reportProviderSuccess(1, 'https://rpc-a.example');
  assert.equal(logs.length, 2);
  assert.equal(logs[1].level, 'info');
  assert.equal(logs[1].msg, 'rpc-endpoint-recovered');
  assert.equal(logs[1].meta.chainId, 1);
  assert.equal(logs[1].meta.rpcUrl, 'https://rpc-a.example');
});

test('logFn: success on already-healthy endpoint emits nothing', () => {
  const logs: Array<{ level: string; msg: string; meta: Record<string, unknown> }> = [];
  const pool = new ProviderPool({
    logFn: (level, msg, meta) => logs.push({ level, msg, meta }),
  });

  pool.reportProviderSuccess(1, 'https://rpc-a.example');
  assert.equal(logs.length, 0, 'no log on success of healthy endpoint');
});

test('logFn: not provided → silent (no crash)', () => {
  const pool = new ProviderPool({ failureThreshold: 1 });
  // Should not throw
  pool.reportProviderFailure(1, 'https://rpc-a.example', 'ECONNRESET');
  pool.reportProviderSuccess(1, 'https://rpc-a.example');
});

test('logFn: configure() wires logFn after construction', () => {
  const logs: Array<{ level: string; msg: string; meta: Record<string, unknown> }> = [];
  const pool = new ProviderPool({ failureThreshold: 1, suppressionMs: 60_000, now: () => 1000 });

  // No logFn yet — should be silent
  pool.reportProviderFailure(1, 'https://rpc-a.example', 'ECONNRESET');
  assert.equal(logs.length, 0, 'no log before configure');

  // Wire logFn via configure
  pool.configure({ logFn: (level, msg, meta) => logs.push({ level, msg, meta }) });

  // Now suppression should be logged
  pool.reportProviderFailure(1, 'https://rpc-b.example', 'ECONNRESET');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].msg, 'rpc-endpoint-suppressed');
  assert.equal(logs[0].meta.rpcUrl, 'https://rpc-b.example');
});

test('logFn: configure({ logFn: undefined }) disables logging', () => {
  const logs: Array<{ level: string; msg: string; meta: Record<string, unknown> }> = [];
  const pool = new ProviderPool({
    failureThreshold: 1,
    suppressionMs: 60_000,
    now: () => 1000,
    logFn: (level, msg, meta) => logs.push({ level, msg, meta }),
  });

  pool.reportProviderFailure(1, 'https://rpc-a.example', 'ECONNRESET');
  assert.equal(logs.length, 1, 'logged before disable');

  pool.configure({ logFn: undefined });

  pool.reportProviderFailure(1, 'https://rpc-b.example', 'ECONNRESET');
  assert.equal(logs.length, 1, 'no log after disable');
});
