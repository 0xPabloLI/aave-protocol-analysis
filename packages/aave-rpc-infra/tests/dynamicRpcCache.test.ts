import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamicRpcCache } from '../src/dynamicRpcCache.js';
import { setTimeout as sleep } from 'node:timers/promises';

test('DynamicRpcCache: cache miss → get returns undefined', () => {
  const cache = new DynamicRpcCache();
  assert.equal(cache.get(99999), undefined);
});

test('DynamicRpcCache: cache set → get returns URLs', () => {
  const cache = new DynamicRpcCache();
  cache.set(1, ['https://rpc-a.example', 'https://rpc-b.example']);
  assert.deepEqual(cache.get(1), ['https://rpc-a.example', 'https://rpc-b.example']);
});

test('DynamicRpcCache: invalidate → get returns undefined', () => {
  const cache = new DynamicRpcCache();
  cache.set(1, ['https://rpc-a.example']);
  cache.invalidate(1);
  assert.equal(cache.get(1), undefined);
});

test('DynamicRpcCache: startFetch success (both sources) → cache populated with merged deduped https URLs', async () => {
  const cache = new DynamicRpcCache({
    fetchChainIdNetwork: async () => ['https://chainid-a.example', 'https://chainid-b.example'],
    fetchChainListOrg: async () => ['https://chainlist-c.example', 'https://chainid-a.example'],
  });
  cache.startFetch(1);
  await sleep(50);
  const urls = cache.get(1);
  assert.deepEqual(urls, ['https://chainid-a.example', 'https://chainid-b.example', 'https://chainlist-c.example']);
});

test('DynamicRpcCache: startFetch one source fails → cache populated with successful source URLs', async () => {
  const cache = new DynamicRpcCache({
    fetchChainIdNetwork: async () => ['https://chainid-a.example'],
    fetchChainListOrg: async () => { throw new Error('network error'); },
  });
  cache.startFetch(1);
  await sleep(50);
  assert.deepEqual(cache.get(1), ['https://chainid-a.example']);
});

test('DynamicRpcCache: startFetch both sources fail → cache unchanged, no throw', async () => {
  const cache = new DynamicRpcCache({
    fetchChainIdNetwork: async () => { throw new Error('err1'); },
    fetchChainListOrg: async () => { throw new Error('err2'); },
  });
  cache.startFetch(1);
  await sleep(50);
  assert.equal(cache.get(1), undefined);
});

test('DynamicRpcCache: startFetch filters out non-https URLs', async () => {
  const cache = new DynamicRpcCache({
    fetchChainIdNetwork: async () => ['https://valid.example', 'wss://invalid.example', 'http://also-invalid.example'],
    fetchChainListOrg: async () => [],
  });
  cache.startFetch(1);
  await sleep(50);
  assert.deepEqual(cache.get(1), ['https://valid.example']);
});
