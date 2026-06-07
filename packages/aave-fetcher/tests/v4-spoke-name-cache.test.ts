import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSpokeNameCache } from '../src/v4-fetcher.js';
import type { RuntimeReserveData } from '@internal/aave-shared-contracts';

function makeReserve(overrides: Partial<RuntimeReserveData> = {}): RuntimeReserveData {
  return {
    reserveId: overrides.reserveId ?? '1:0xspoke:0xtoken:0xhub',
    marketName: overrides.marketName ?? 'AaveV4Main',
    chainName: 'Ethereum',
    chainId: 1,
    tokenName: 'Test',
    tokenSymbol: 'TEST',
    tokenAddress: '0xtoken',
    aTokenAddress: null,
    vTokenAddress: null,
    ...overrides,
  } as RuntimeReserveData;
}

test('extractSpokeNameCache extracts spoke and hub name mappings', () => {
  const reserves = [
    makeReserve({
      spokeAddress: '0xSpokeA',
      spokeName: 'Main',
      hubAddress: '0xHubA',
      hubName: 'Core',
    }),
    makeReserve({
      spokeAddress: '0xSpokeB',
      spokeName: 'Bluechip',
      hubAddress: '0xHubB',
      hubName: 'Prime',
    }),
  ];

  const { spokeNames, hubNames } = extractSpokeNameCache(reserves);

  assert.strictEqual(spokeNames.get('0xspokea'), 'Main');
  assert.strictEqual(spokeNames.get('0xspokeb'), 'Bluechip');
  assert.strictEqual(hubNames.get('0xhuba'), 'Core');
  assert.strictEqual(hubNames.get('0xhubb'), 'Prime');
});

test('extractSpokeNameCache deduplicates by address', () => {
  const reserves = [
    makeReserve({ spokeAddress: '0xSpokeA', spokeName: 'Main', hubAddress: '0xHubA', hubName: 'Core' }),
    makeReserve({ spokeAddress: '0xSpokeA', spokeName: 'Main', hubAddress: '0xHubA', hubName: 'Core' }),
  ];

  const { spokeNames, hubNames } = extractSpokeNameCache(reserves);

  assert.strictEqual(spokeNames.size, 1);
  assert.strictEqual(hubNames.size, 1);
});

test('extractSpokeNameCache skips reserves without spokeAddress/spokeName', () => {
  const reserves = [
    makeReserve({ spokeAddress: '0xSpokeA', spokeName: 'Main', hubAddress: '0xHubA', hubName: 'Core' }),
    makeReserve({ hubAddress: '0xHubB', hubName: 'Prime' } as any),
  ];

  const { spokeNames, hubNames } = extractSpokeNameCache(reserves);

  assert.strictEqual(spokeNames.size, 1);
  assert.strictEqual(hubNames.size, 2);
});

test('extractSpokeNameCache returns empty maps for empty input', () => {
  const { spokeNames, hubNames } = extractSpokeNameCache([]);
  assert.strictEqual(spokeNames.size, 0);
  assert.strictEqual(hubNames.size, 0);
});

// --- applyCachedNames integration tests ---

import { fetchV4ReservesWithTimeout, clearSpokeNameCache } from '../src/concurrent-fetch.js';

test('RPC fallback reserves are enriched with cached SDK names', async () => {
  // First: SDK succeeds, populating the name cache
  const sdkReserve = makeReserve({
    reserveId: '1:0xspokea:0xtoken:0xhuba',
    spokeAddress: '0xSpokeA',
    spokeName: 'Main',
    hubAddress: '0xHubA',
    hubName: 'Core',
    marketName: 'AaveV4Main',
  });

  const sdkResult = await fetchV4ReservesWithTimeout({
    _fetchV4Fn: async () => ({
      mapped: [sdkReserve],
      raw: { reserves: [] },
      spokeHubTopology: [],
    }),
  });

  assert.strictEqual(sdkResult.source, 'sdk');

  // Now: SDK fails → RPC fallback with address-book-style names
  const rpcReserve = makeReserve({
    reserveId: '1:0xspokea:0xtoken:0xhuba',
    spokeAddress: '0xSpokeA',
    spokeName: 'MAIN_SPOKE',
    hubAddress: '0xHubA',
    hubName: 'CORE_HUB',
    marketName: 'AaveV4MAIN_SPOKE',
  });

  const rpcResult = await fetchV4ReservesWithTimeout({
    _fetchV4Fn: async () => ({
      mapped: [],
      raw: { reserves: [] },
      spokeHubTopology: [],
    }),
    _fetchRpcFn: async () => ({
      reserves: [rpcReserve],
      errors: [],
    }),
  });

  assert.strictEqual(rpcResult.source, 'rpc');
  assert.strictEqual(rpcResult.mapped.length, 1);
  // spokeName should be enriched from cache: "Main" not "MAIN_SPOKE"
  assert.strictEqual(rpcResult.mapped[0].spokeName, 'Main');
  assert.strictEqual(rpcResult.mapped[0].hubName, 'Core');
  assert.strictEqual(rpcResult.mapped[0].marketName, 'AaveV4Main');

  // Cleanup
  clearSpokeNameCache();
});

test('RPC fallback keeps original names when SDK cache is empty', async () => {
  clearSpokeNameCache();

  const rpcReserve = makeReserve({
    reserveId: '1:0xspokea:0xtoken:0xhuba',
    spokeAddress: '0xSpokeA',
    spokeName: 'MAIN_SPOKE',
    hubAddress: '0xHubA',
    hubName: 'CORE_HUB',
    marketName: 'AaveV4MAIN_SPOKE',
  });

  const result = await fetchV4ReservesWithTimeout({
    _fetchV4Fn: async () => ({
      mapped: [],
      raw: { reserves: [] },
      spokeHubTopology: [],
    }),
    _fetchRpcFn: async () => ({
      reserves: [rpcReserve],
      errors: [],
    }),
  });

  assert.strictEqual(result.source, 'rpc');
  // No cache → original address-book names preserved
  assert.strictEqual(result.mapped[0].spokeName, 'MAIN_SPOKE');
  assert.strictEqual(result.mapped[0].hubName, 'CORE_HUB');

  clearSpokeNameCache();
});
