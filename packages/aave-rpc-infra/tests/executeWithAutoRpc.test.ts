import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderPool } from '../src/index.js';

test('executeWithAutoRpc: existing chain (shared-config has URLs) → uses shared-config URLs', async () => {
  const pool = new ProviderPool();
  const result = await pool.executeWithAutoRpc(
    1,
    {
      primary: async (_p) => 'ok',
    },
  );
  assert.equal(result, 'ok');
});

test('executeWithAutoRpc: all layers empty → returns null', async () => {
  const pool = new ProviderPool();
  pool.seedDynamicRpcCache(999999, []);
  const result = await pool.executeWithAutoRpc(
    999999,
    {
      primary: async (_p) => 'should-not-reach',
    },
  );
  assert.equal(result, null);
});

test('executeWithAutoRpc: new chain with viem/chains RPC → returns result and triggers background fetch', async () => {
  let fetchTriggered = false;
  let warnMsg = '';
  const pool = new ProviderPool({
    warnFn: (msg) => { warnMsg = msg; },
  });
  pool.setDynamicRpcCacheHooks({
    onFetchTriggered: () => { fetchTriggered = true; },
  });

  const result = await pool.executeWithAutoRpc(
    288,
    {
      primary: async (_p) => 'boba-result',
    },
  );

  assert.equal(result, 'boba-result');
  assert.equal(fetchTriggered, true);
  assert.ok(warnMsg.includes('288'), `warn should mention chainId 288, got: ${warnMsg}`);
});

test('executeWithAutoRpc: new chain, dynamic cache hit → uses cached URLs', async () => {
  const pool = new ProviderPool();
  pool.seedDynamicRpcCache(99999, ['https://cached-rpc.example']);

  const result = await pool.executeWithAutoRpc(
    99999,
    {
      primary: async (_p) => 'cached-result',
    },
  );

  assert.equal(result, 'cached-result');
});

test('executeWithAutoRpc: all dynamic URLs suppressed → invalidates cache and re-resolves', async () => {
  let now = 1_000;
  const pool = new ProviderPool({
    failureThreshold: 1,
    suppressionMs: 60_000,
    now: () => now,
  });

  pool.seedDynamicRpcCache(288, ['https://suppressed-rpc.example']);
  pool.reportProviderFailure(288, 'https://suppressed-rpc.example', 'fail');

  now += 1;

  const result = await pool.executeWithAutoRpc(
    288,
    {
      primary: async (_p) => 'viem-fallback-result',
    },
  );

  assert.equal(result, 'viem-fallback-result');
});
