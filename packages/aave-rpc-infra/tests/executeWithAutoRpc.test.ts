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
    logFn: (_level, msg, _meta) => { warnMsg = msg; },
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
  assert.ok(warnMsg.includes('new-chain-detected'), `warn should mention new-chain-detected, got: ${warnMsg}`);
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

test('executeWithAutoRpc: hardcoded chain all suppressed → appends viem/chains URLs to the pool', async () => {
  let now = 1_000;
  let usedViemUrl = false;
  const pool = new ProviderPool({
    failureThreshold: 1,
    suppressionMs: 60_000,
    now: () => now,
    errorClassifier: () => 'retry_next_rpc' as const,
  });

  const hardcodedUrls = await import('@internal/aave-shared-config').then(m => m.getAaveRpcUrlsByChainId(1));
  const hardcodedSet = new Set(hardcodedUrls);
  for (const url of hardcodedUrls) {
    pool.reportProviderFailure(1, url, 'fail');
  }

  now += 1;

  const result = await pool.executeWithAutoRpc(
    1,
    {
      primary: async (_p) => {
        const url = (_p as any).connection?.url ?? '';
        if (hardcodedSet.has(url)) {
          throw new Error('hardcoded-rpc-fail');
        }
        usedViemUrl = true;
        return 'viem-fallback-ok';
      },
    },
  );

  assert.equal(result, 'viem-fallback-ok');
  assert.equal(usedViemUrl, true);
});

test('executeWithAutoRpc: hardcoded + viem all suppressed, dynamic cache available → uses dynamic URLs', async () => {
  let now = 1_000;
  const pool = new ProviderPool({
    failureThreshold: 1,
    suppressionMs: 60_000,
    now: () => now,
    errorClassifier: () => 'retry_next_rpc' as const,
  });

  const hardcodedUrls = await import('@internal/aave-shared-config').then(m => m.getAaveRpcUrlsByChainId(1));
  for (const url of hardcodedUrls) {
    pool.reportProviderFailure(1, url, 'fail');
  }

  const viemModule = await import('viem/chains');
  const viem = await import('viem');
  const chain = viem.extractChain({ chains: Object.values(viemModule) as any[], id: 1 });
  const viemUrls = chain?.rpcUrls?.default?.http?.filter((u: string) => u.startsWith('https://')) ?? [];
  for (const url of viemUrls) {
    pool.reportProviderFailure(1, url, 'fail');
  }

  pool.seedDynamicRpcCache(1, ['https://dynamic-rpc.example']);

  now += 1;

  const result = await pool.executeWithAutoRpc(
    1,
    {
      primary: async (_p) => {
        const url = (_p as any).connection?.url ?? '';
        if (url === 'https://dynamic-rpc.example') return 'dynamic-fallback-ok';
        throw new Error('other-rpc-fail');
      },
    },
  );

  assert.equal(result, 'dynamic-fallback-ok');
});

test('executeWithAutoRpc: non-hardcoded chain still triggers new-chain detection', async () => {
  let fetchTriggered = false;
  let warnMsg = '';
  const pool = new ProviderPool({
    logFn: (_level, msg, _meta) => { warnMsg = msg; },
  });
  pool.setDynamicRpcCacheHooks({
    onFetchTriggered: () => { fetchTriggered = true; },
  });

  await pool.executeWithAutoRpc(
    288,
    {
      primary: async (_p) => 'new-chain-ok',
    },
  );

  assert.equal(fetchTriggered, true);
  assert.ok(warnMsg.includes('new-chain-detected'));
});

test('executeWithAutoRpc: all layers exhausted for unknown chain → returns null', async () => {
  const pool = new ProviderPool();
  const result = await pool.executeWithAutoRpc(
    999999,
    {
      primary: async (_p) => 'should-not-reach',
    },
  );
  assert.equal(result, null);
});
