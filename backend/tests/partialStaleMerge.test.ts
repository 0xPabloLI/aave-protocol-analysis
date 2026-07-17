import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFetchResultOrDefault, mergeWithPartialStale, correctFetchResult } from '../src/services/marketsService.js';
import type { PartialStaleMergeInput } from '../src/services/marketsService.js';
import type { RuntimeReserveData } from '@internal/aave-shared-contracts';

const FIVE_MINUTES = 5 * 60 * 1000;

test('missing fetchResult envelope defaults both sides to SDK success', () => {
  const result = getFetchResultOrDefault({
    timestamp: new Date().toISOString(),
    version: '2.0-runtime-minimal',
    dataCount: 0,
    profile: 'runtime-minimal',
  });

  assert.deepEqual(result, {
    v3: { success: true, source: 'sdk' },
    v4: { success: true, source: 'sdk' },
  });
});

/** Minimal V3 reserve (no hubId). */
function makeV3(overrides?: Partial<RuntimeReserveData>): RuntimeReserveData {
  return {
    reserveId: `1:0xpool:0xusdc`,
    chainName: 'Ethereum',
    chainId: 1,
    tokenSymbol: 'USDC',
    tokenName: 'USD Coin',
    tokenAddress: '0xusdc',
    tokenPrice: 1,
    supplyApy: 0.03,
    borrowApy: 0.05,
    utilizationPct: 0.6,
    supplyCap: '10000000',
    borrowCap: '8000000',
    supplied: '5000000',
    borrowed: '3000000',
    liquidity: '2000000',
    decimals: 6,
    deficit: '0',
    aTokenAddress: '0xatoken',
    vTokenAddress: '0xvtoken',
    marketName: 'Aave V3 Main',
    supplyDisabled: false,
    borrowDisabled: false,
    isFrozen: false,
    isPaused: false,
    meritSupplys: [],
    meritBorrows: [],
    merklSupplys: [],
    merklBorrows: [],
    merklHolds: [],
    brevisSupplys: [],
    brevisBorrows: [],
    ...overrides,
  } as RuntimeReserveData;
}

/** Minimal V4 reserve (has hubId). */
function makeV4(overrides?: Partial<RuntimeReserveData>): RuntimeReserveData {
  return {
    reserveId: `42161:0xspoke:0xv4usdt:0xcca852bc40e560adc3b1cc58ca5b55638ce826c9`,
    chainName: 'Arbitrum',
    chainId: 42161,
    tokenSymbol: 'USDT',
    tokenName: 'Tether USD',
    tokenAddress: '0xv4usdt',
    tokenPrice: 1,
    supplyApy: 0.04,
    borrowApy: 0.06,
    utilizationPct: 0.7,
    supplyCap: '5000000',
    borrowCap: '4000000',
    supplied: '3000000',
    borrowed: '2000000',
    liquidity: '1000000',
    decimals: 6,
    deficit: '0',
    aTokenAddress: '0xatokenv4',
    vTokenAddress: '0xvtokenv4',
    marketName: 'Aave V4',
    aaveProReserveId: undefined,
    hubId: '1',
    hubName: 'CORE_HUB',
    hubAddress: '0xhub',
    spokeId: '1',
    spokeName: 'BLUECHIP_SPOKE',
    spokeAddress: '0xspoke',
    supplyDisabled: false,
    borrowDisabled: false,
    isFrozen: false,
    isPaused: false,
    meritSupplys: [],
    meritBorrows: [],
    merklSupplys: [],
    merklBorrows: [],
    merklHolds: [],
    brevisSupplys: [],
    brevisBorrows: [],
    ...overrides,
  } as RuntimeReserveData;
}

function baseInput(overrides: Partial<PartialStaleMergeInput>): PartialStaleMergeInput {
  return {
    freshData: [],
    v3Succeeded: true,
    v4Succeeded: true,
    v4Source: 'sdk',
    staleV3Data: [],
    staleV4Data: [],
    v3FetchedAt: null,
    v4FetchedAt: null,
    hardTtlMs: FIVE_MINUTES,
    now: Date.now(),
    ...overrides,
  };
}

// ── ACCEPTANCE: both success ──────────────────────────────────

test('both succeed → full merged dataset, both fetchedAt updated', () => {
  const now = Date.now();
  const freshV3 = makeV3({ tokenSymbol: 'USDC' });
  const freshV4 = makeV4({ tokenSymbol: 'USDT' });

  const result = mergeWithPartialStale(baseInput({
    freshData: [freshV3, freshV4],
    v3Succeeded: true,
    v4Succeeded: true,
    v3FetchedAt: null,
    v4FetchedAt: null,
    now,
  }));

  assert.equal(result.mergedData.length, 2);
  assert.ok(result.mergedData.find(r => r.tokenSymbol === 'USDC'));
  assert.ok(result.mergedData.find(r => r.tokenSymbol === 'USDT'));
  assert.equal(result.newV3FetchedAt, now);
  assert.equal(result.newV4FetchedAt, now);
  assert.equal(result.v3Fresh, true);
  assert.equal(result.v4Fresh, true);
  assert.equal(result.newStaleV3Data.length, 1);
  assert.equal(result.newStaleV4Data.length, 1);
});

// ── V3 TIMEOUT + V4 OK → V3 stale fallback ────────────────────

test('V3 timeout + V4 OK → V3 uses stale, V4 uses new', () => {
  const now = Date.now();
  const staleV3 = makeV3({ tokenSymbol: 'DAI' });
  const freshV4 = makeV4({ tokenSymbol: 'USDT' });

  const result = mergeWithPartialStale(baseInput({
    freshData: [freshV4], // V3 timed out, only V4 data
    v3Succeeded: false,
    v4Succeeded: true,
    staleV3Data: [staleV3],
    staleV4Data: [],
    v3FetchedAt: now - 60_000, // 1 minute ago, within TTL
    v4FetchedAt: null,
    now,
  }));

  assert.equal(result.mergedData.length, 2);
  assert.ok(result.mergedData.find(r => r.tokenSymbol === 'DAI'));
  assert.ok(result.mergedData.find(r => r.tokenSymbol === 'USDT'));
  // V3 stale unchanged (no fresh V3), V4 fetchedAt updated
  assert.equal(result.newV3FetchedAt, now - 60_000); // unchanged
  assert.equal(result.newV4FetchedAt, now); // updated
  assert.equal(result.newStaleV3Data.length, 1); // still the old stale
  assert.equal(result.newStaleV4Data.length, 1); // new V4 data
  assert.equal(result.v3Fresh, false);
  assert.equal(result.v4Fresh, true);
});

// ── V4 TIMEOUT + V3 OK → V4 stale fallback ────────────────────

test('V4 timeout + V3 OK → V4 uses stale, V3 uses new', () => {
  const now = Date.now();
  const freshV3 = makeV3({ tokenSymbol: 'USDC' });
  const staleV4 = makeV4({ tokenSymbol: 'WETH' });

  const result = mergeWithPartialStale(baseInput({
    freshData: [freshV3], // V4 timed out, only V3 data
    v3Succeeded: true,
    v4Succeeded: false,
    staleV3Data: [],
    staleV4Data: [staleV4],
    v3FetchedAt: null,
    v4FetchedAt: now - 120_000, // 2 minutes ago, within TTL
    now,
  }));

  assert.equal(result.mergedData.length, 2);
  assert.ok(result.mergedData.find(r => r.tokenSymbol === 'USDC'));
  assert.ok(result.mergedData.find(r => r.tokenSymbol === 'WETH'));
  assert.equal(result.newV3FetchedAt, now); // updated
  assert.equal(result.newV4FetchedAt, now - 120_000); // unchanged
  assert.equal(result.v3Fresh, true);
  assert.equal(result.v4Fresh, false);
});

// ── V3 stale expired ──────────────────────────────────────────

test('V3 timeout + v3FetchedAt > hardTtl → V3 = []', () => {
  const now = Date.now();
  const staleV3 = makeV3({ tokenSymbol: 'DAI' });
  const freshV4 = makeV4({ tokenSymbol: 'USDT' });

  const result = mergeWithPartialStale(baseInput({
    freshData: [freshV4],
    v3Succeeded: false,
    v4Succeeded: true,
    staleV3Data: [staleV3],
    staleV4Data: [],
    v3FetchedAt: now - (FIVE_MINUTES + 1), // just past TTL
    v4FetchedAt: null,
    now,
  }));

  assert.equal(result.mergedData.length, 1);
  // Only V4 — V3 stale expired
  assert.equal(result.mergedData[0].tokenSymbol, 'USDT');
  assert.equal(result.v3Fresh, false);
  assert.equal(result.v4Fresh, true);
});

// ── V4 stale expired ──────────────────────────────────────────

test('V4 timeout + v4FetchedAt > hardTtl → V4 = []', () => {
  const now = Date.now();
  const freshV3 = makeV3({ tokenSymbol: 'USDC' });
  const staleV4 = makeV4({ tokenSymbol: 'WETH' });

  const result = mergeWithPartialStale(baseInput({
    freshData: [freshV3],
    v3Succeeded: true,
    v4Succeeded: false,
    staleV3Data: [],
    staleV4Data: [staleV4],
    v3FetchedAt: null,
    v4FetchedAt: now - (FIVE_MINUTES + 1),
    now,
  }));

  assert.equal(result.mergedData.length, 1);
  assert.equal(result.mergedData[0].tokenSymbol, 'USDC');
});

// ── Both timeout + both stale within TTL → all stale ─────────

test('both timeout + both stale within TTL → merged with all stale', () => {
  const now = Date.now();
  const staleV3 = makeV3({ tokenSymbol: 'DAI' });
  const staleV4 = makeV4({ tokenSymbol: 'WETH' });

  const result = mergeWithPartialStale(baseInput({
    freshData: [], // both timed out
    v3Succeeded: false,
    v4Succeeded: false,
    staleV3Data: [staleV3],
    staleV4Data: [staleV4],
    v3FetchedAt: now - 60_000, // within TTL
    v4FetchedAt: now - 120_000, // within TTL
    now,
  }));

  assert.equal(result.mergedData.length, 2);
  assert.equal(result.v3Fresh, false);
  assert.equal(result.v4Fresh, false);
});

// ── Both timeout + both stale expired → empty ─────────────────

test('both timeout + both stale expired → mergedData = []', () => {
  const now = Date.now();
  const staleV3 = makeV3({ tokenSymbol: 'DAI' });
  const staleV4 = makeV4({ tokenSymbol: 'WETH' });

  const result = mergeWithPartialStale(baseInput({
    freshData: [],
    v3Succeeded: false,
    v4Succeeded: false,
    staleV3Data: [staleV3],
    staleV4Data: [staleV4],
    v3FetchedAt: now - (FIVE_MINUTES + 1),
    v4FetchedAt: now - (FIVE_MINUTES + 1),
    now,
  }));

  assert.equal(result.mergedData.length, 0);
  assert.equal(result.v3Fresh, false);
  assert.equal(result.v4Fresh, false);
});

// ── Edge: never fetched (fetchedAt = null) → no stale fallback ─

test('V3 never fetched → timeout means V3 = []', () => {
  const now = Date.now();
  const freshV4 = makeV4({ tokenSymbol: 'USDT' });

  const result = mergeWithPartialStale(baseInput({
    freshData: [freshV4],
    v3Succeeded: false,
    v4Succeeded: true,
    staleV3Data: [],
    staleV4Data: [],
    v3FetchedAt: null, // never fetched
    v4FetchedAt: null,
    now,
  }));

  assert.equal(result.mergedData.length, 1);
  assert.equal(result.mergedData[0].tokenSymbol, 'USDT');
  assert.equal(result.v3Fresh, false);
});

// ── Backward compat: missing fetchResult envelope → treat as SDK success ─

test('both succeeded with empty stale → fresh data only', () => {
  const freshV3 = makeV3({ tokenSymbol: 'USDC' });
  const freshV4 = makeV4({ tokenSymbol: 'USDT' });

  const result = mergeWithPartialStale(baseInput({
    freshData: [freshV3, freshV4],
    v3Succeeded: true,
    v4Succeeded: true,
    staleV3Data: [],
    staleV4Data: [],
    v3FetchedAt: null,
    v4FetchedAt: null,
    now: Date.now(),
  }));

  assert.equal(result.mergedData.length, 2);
  assert.equal(result.v3Fresh, true);
  assert.equal(result.v4Fresh, true);
});

// ── Edge: only V4 data in stale (V3 was never fetched) ────────

test('only V4 stale available + both timeout → V4 stale used, V3 empty', () => {
  const now = Date.now();
  const staleV4 = makeV4({ tokenSymbol: 'WETH' });

  const result = mergeWithPartialStale(baseInput({
    freshData: [],
    v3Succeeded: false,
    v4Succeeded: false,
    staleV3Data: [],
    staleV4Data: [staleV4],
    v3FetchedAt: null,
    v4FetchedAt: now - 60_000,
    now,
  }));

  assert.equal(result.mergedData.length, 1);
  assert.equal(result.mergedData[0].tokenSymbol, 'WETH');
});

// ── v3Present / v4Present ─────────────────────────────────────

test('both succeed → v3Present=true, v4Present=true', () => {
  const now = Date.now();
  const freshV3 = makeV3({ tokenSymbol: 'USDC' });
  const freshV4 = makeV4({ tokenSymbol: 'USDT' });

  const result = mergeWithPartialStale(baseInput({
    freshData: [freshV3, freshV4],
    v3Succeeded: true,
    v4Succeeded: true,
    now,
  }));

  assert.equal(result.v3Present, true);
  assert.equal(result.v4Present, true);
});

test('V3 timeout + stale fallback → v3Present=true, V4 fresh → v4Present=true', () => {
  const now = Date.now();
  const staleV3 = makeV3({ tokenSymbol: 'DAI' });
  const freshV4 = makeV4({ tokenSymbol: 'USDT' });

  const result = mergeWithPartialStale(baseInput({
    freshData: [freshV4],
    v3Succeeded: false,
    v4Succeeded: true,
    staleV3Data: [staleV3],
    v3FetchedAt: now - 60_000,
    now,
  }));

  assert.equal(result.v3Present, true);
  assert.equal(result.v4Present, true);
});

test('V3 timeout + stale expired → v3Present=false', () => {
  const now = Date.now();
  const staleV3 = makeV3({ tokenSymbol: 'DAI' });
  const freshV4 = makeV4({ tokenSymbol: 'USDT' });

  const result = mergeWithPartialStale(baseInput({
    freshData: [freshV4],
    v3Succeeded: false,
    v4Succeeded: true,
    staleV3Data: [staleV3],
    v3FetchedAt: now - (FIVE_MINUTES + 1),
    now,
  }));

  assert.equal(result.v3Present, false);
  assert.equal(result.v4Present, true);
});

test('V3 timeout + never fetched → v3Present=false', () => {
  const now = Date.now();
  const freshV4 = makeV4({ tokenSymbol: 'USDT' });

  const result = mergeWithPartialStale(baseInput({
    freshData: [freshV4],
    v3Succeeded: false,
    v4Succeeded: true,
    staleV3Data: [],
    v3FetchedAt: null,
    now,
  }));

  assert.equal(result.v3Present, false);
  assert.equal(result.v4Present, true);
});

test('both timeout + both stale within TTL → v3Present=true, v4Present=true', () => {
  const now = Date.now();
  const staleV3 = makeV3({ tokenSymbol: 'DAI' });
  const staleV4 = makeV4({ tokenSymbol: 'WETH' });

  const result = mergeWithPartialStale(baseInput({
    freshData: [],
    v3Succeeded: false,
    v4Succeeded: false,
    staleV3Data: [staleV3],
    staleV4Data: [staleV4],
    v3FetchedAt: now - 60_000,
    v4FetchedAt: now - 120_000,
    now,
  }));

  assert.equal(result.v3Present, true);
  assert.equal(result.v4Present, true);
});

test('both timeout + both stale expired → v3Present=false, v4Present=false', () => {
  const now = Date.now();
  const staleV3 = makeV3({ tokenSymbol: 'DAI' });
  const staleV4 = makeV4({ tokenSymbol: 'WETH' });

  const result = mergeWithPartialStale(baseInput({
    freshData: [],
    v3Succeeded: false,
    v4Succeeded: false,
    staleV3Data: [staleV3],
    staleV4Data: [staleV4],
    v3FetchedAt: now - (FIVE_MINUTES + 1),
    v4FetchedAt: now - (FIVE_MINUTES + 1),
    now,
  }));

  assert.equal(result.v3Present, false);
  assert.equal(result.v4Present, false);
});

test('V3 succeeded with empty fresh data → v3Present=true', () => {
  const now = Date.now();
  const freshV4 = makeV4({ tokenSymbol: 'USDT' });

  const result = mergeWithPartialStale(baseInput({
    freshData: [freshV4],
    v3Succeeded: true,
    v4Succeeded: true,
    now,
  }));

  assert.equal(result.v3Present, true);
  assert.equal(result.v4Present, true);
});

// ── correctFetchResult ─────────────────────────────────────────

test('correctFetchResult: fresh SDK success → preserves original source', () => {
  const result = correctFetchResult(
    { v3: { success: true, source: 'sdk' }, v4: { success: true, source: 'sdk' } },
    true, true, true, true
  );
  assert.deepEqual(result.v3, { success: true, source: 'sdk' });
  assert.deepEqual(result.v4, { success: true, source: 'sdk' });
});

test('correctFetchResult: fresh RPC success → preserves rpc source', () => {
  const result = correctFetchResult(
    { v3: { success: true, source: 'sdk' }, v4: { success: true, source: 'rpc' } },
    true, true, true, true
  );
  assert.deepEqual(result.v3, { success: true, source: 'sdk' });
  assert.deepEqual(result.v4, { success: true, source: 'rpc' });
});

test('correctFetchResult: SDK failed + stale fallback → source=stale, success=true', () => {
  const result = correctFetchResult(
    { v3: { success: true, source: 'sdk' }, v4: { success: false, source: 'none' } },
    true, false, true, true
  );
  assert.deepEqual(result.v3, { success: true, source: 'sdk' });
  assert.deepEqual(result.v4, { success: true, source: 'stale' });
});

test('correctFetchResult: SDK failed + no stale → source=none, success=false', () => {
  const result = correctFetchResult(
    { v3: { success: true, source: 'sdk' }, v4: { success: false, source: 'none' } },
    true, false, true, false
  );
  assert.deepEqual(result.v3, { success: true, source: 'sdk' });
  assert.deepEqual(result.v4, { success: false, source: 'none' });
});

test('correctFetchResult: both sides stale → both source=stale', () => {
  const result = correctFetchResult(
    { v3: { success: false, source: 'none' }, v4: { success: false, source: 'none' } },
    false, false, true, true
  );
  assert.deepEqual(result.v3, { success: true, source: 'stale' });
  assert.deepEqual(result.v4, { success: true, source: 'stale' });
});

test('correctFetchResult: both sides failed + no stale → both source=none', () => {
  const result = correctFetchResult(
    { v3: { success: false, source: 'none' }, v4: { success: false, source: 'none' } },
    false, false, false, false
  );
  assert.deepEqual(result.v3, { success: false, source: 'none' });
  assert.deepEqual(result.v4, { success: false, source: 'none' });
});

// ── RPC fallback stale cache protection (AAV-1063) ────────────────

test('V4 RPC fallback → does NOT update stale cache (prevents "Unknown" poisoning)', () => {
  const now = Date.now();
  const goodStaleV4 = makeV4({ tokenSymbol: 'WETH', tokenName: 'Wrapped Ether', chainName: 'Ethereum' });
  const rpcV4 = makeV4({ tokenSymbol: 'Unknown', tokenName: 'Unknown', chainName: 'Chain 42161' });

  const result = mergeWithPartialStale(baseInput({
    freshData: [rpcV4],
    v3Succeeded: true,
    v4Succeeded: true,
    v4Source: 'rpc',
    staleV3Data: [],
    staleV4Data: [goodStaleV4],
    v3FetchedAt: null,
    v4FetchedAt: now - 60_000,
    now,
  }));

  // Stale cache should NOT be updated with RPC "Unknown" data
  assert.equal(result.newStaleV4Data.length, 1);
  assert.equal(result.newStaleV4Data[0].tokenSymbol, 'WETH');
  assert.equal(result.newStaleV4Data[0].tokenName, 'Wrapped Ether');
  // v4FetchedAt should NOT be updated for RPC source
  assert.equal(result.newV4FetchedAt, now - 60_000);
  assert.equal(result.v4Fresh, true);
});

test('V4 RPC fallback → enriches "Unknown" fields from stale cache', () => {
  const now = Date.now();
  const goodStaleV4 = makeV4({ tokenSymbol: 'USDT', tokenName: 'Tether USD', chainName: 'Arbitrum' });
  const rpcV4 = makeV4({ tokenSymbol: 'Unknown', tokenName: 'Unknown', chainName: 'Chain 42161' });

  const result = mergeWithPartialStale(baseInput({
    freshData: [rpcV4],
    v3Succeeded: true,
    v4Succeeded: true,
    v4Source: 'rpc',
    staleV3Data: [],
    staleV4Data: [goodStaleV4],
    v3FetchedAt: null,
    v4FetchedAt: now - 60_000,
    now,
  }));

  // Merged data should have enriched fields from stale cache
  assert.equal(result.mergedData.length, 1);
  const merged = result.mergedData[0];
  assert.equal(merged.tokenName, 'Tether USD');
  assert.equal(merged.tokenSymbol, 'USDT');
  assert.equal(merged.chainName, 'Arbitrum');
});

test('V4 RPC fallback with no stale → keeps "Unknown" as-is', () => {
  const now = Date.now();
  const rpcV4 = makeV4({ tokenSymbol: 'Unknown', tokenName: 'Unknown', chainName: 'Chain 42161' });

  const result = mergeWithPartialStale(baseInput({
    freshData: [rpcV4],
    v3Succeeded: true,
    v4Succeeded: true,
    v4Source: 'rpc',
    staleV3Data: [],
    staleV4Data: [],
    v3FetchedAt: null,
    v4FetchedAt: null,
    now,
  }));

  // No stale data to enrich from, "Unknown" stays
  assert.equal(result.mergedData.length, 1);
  assert.equal(result.mergedData[0].tokenName, 'Unknown');
  assert.equal(result.mergedData[0].chainName, 'Chain 42161');
  // Stale cache remains empty (not polluted by RPC data)
  assert.equal(result.newStaleV4Data.length, 0);
});

test('V4 SDK success → updates stale cache normally (v4Source=sdk)', () => {
  const now = Date.now();
  const freshV4 = makeV4({ tokenSymbol: 'USDT', tokenName: 'Tether USD' });

  const result = mergeWithPartialStale(baseInput({
    freshData: [freshV4],
    v3Succeeded: true,
    v4Succeeded: true,
    v4Source: 'sdk',
    staleV3Data: [],
    staleV4Data: [],
    now,
  }));

  assert.equal(result.newStaleV4Data.length, 1);
  assert.equal(result.newStaleV4Data[0].tokenSymbol, 'USDT');
  assert.equal(result.newV4FetchedAt, now);
});

test('V4 RPC fallback → stale cache survives multiple cycles', () => {
  const now = Date.now();
  const goodStaleV4 = makeV4({ tokenSymbol: 'WETH', tokenName: 'Wrapped Ether', chainName: 'Ethereum' });
  const rpcV4 = makeV4({ tokenSymbol: 'Unknown', tokenName: 'Unknown', chainName: 'Chain 1' });

  // Cycle 1: RPC fallback
  const result1 = mergeWithPartialStale(baseInput({
    freshData: [rpcV4],
    v3Succeeded: true,
    v4Succeeded: true,
    v4Source: 'rpc',
    staleV3Data: [],
    staleV4Data: [goodStaleV4],
    v3FetchedAt: null,
    v4FetchedAt: now - 60_000,
    now,
  }));

  // Cycle 2: another RPC fallback, using stale from cycle 1
  const result2 = mergeWithPartialStale(baseInput({
    freshData: [rpcV4],
    v3Succeeded: true,
    v4Succeeded: true,
    v4Source: 'rpc',
    staleV3Data: [],
    staleV4Data: result1.newStaleV4Data,
    v3FetchedAt: null,
    v4FetchedAt: result1.newV4FetchedAt,
    now: now + 60_000,
  }));

  // Stale cache should still have good data after 2 cycles
  assert.equal(result2.newStaleV4Data[0].tokenSymbol, 'WETH');
  assert.equal(result2.newStaleV4Data[0].tokenName, 'Wrapped Ether');
  // Enriched merged data from stale
  assert.equal(result2.mergedData[0].tokenSymbol, 'WETH');
  assert.equal(result2.mergedData[0].chainName, 'Ethereum');
});