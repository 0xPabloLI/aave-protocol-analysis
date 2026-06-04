import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKEND_CACHE_TTL_MS, BACKEND_TIME_MS } from '../src/cacheTtl.js';
import { mergeWithPartialStale, getFetchResultOrDefault } from '../src/services/marketsService.js';
import type { PartialStaleMergeInput } from '../src/services/marketsService.js';
import type { RuntimeReserveData } from '@internal/aave-shared-contracts';

test('hardTtl is 5 minutes (kept at original value)', () => {
  assert.equal(
    BACKEND_CACHE_TTL_MS.marketsHardTtlMs,
    BACKEND_TIME_MS.fiveMinutes,
  );
  assert.equal(BACKEND_CACHE_TTL_MS.marketsHardTtlMs, 5 * 60 * 1000);
});

test('Fix 2: stale snapshot still returns payload (not null) — mergeWithPartialStale preserves data', () => {
  const staleReserve = {
    reserveId: '1:0xpool:0xusdc',
    marketName: 'AaveV3Ethereum',
    chainName: 'Ethereum',
    chainId: 1,
    tokenSymbol: 'USDC',
    tokenName: 'USD Coin',
    tokenAddress: '0xusdc',
  } as RuntimeReserveData;

  const now = Date.now();
  const hardTtl = BACKEND_CACHE_TTL_MS.marketsHardTtlMs;

  const input: PartialStaleMergeInput = {
    freshData: [],
    v3Succeeded: false,
    v4Succeeded: false,
    staleV3Data: [staleReserve],
    staleV4Data: [],
    v3FetchedAt: now - hardTtl + 60_000,
    v4FetchedAt: null,
    hardTtlMs: hardTtl,
    now,
  };

  const result = mergeWithPartialStale(input);

  assert.ok(
    result.mergedData.length > 0,
    'When fresh fetch fails but stale V3 is within hardTtl, mergedData should contain stale reserves (not empty)'
  );
  assert.equal(result.mergedData[0].reserveId, '1:0xpool:0xusdc');
});

test('Fix 2: stale snapshot beyond hardTtl returns empty (no phantom data)', () => {
  const staleReserve = {
    reserveId: '1:0xpool:0xdai',
    marketName: 'AaveV3Ethereum',
    chainName: 'Ethereum',
    chainId: 1,
    tokenSymbol: 'DAI',
    tokenName: 'Dai Stablecoin',
    tokenAddress: '0xdai',
  } as RuntimeReserveData;

  const now = Date.now();
  const hardTtl = BACKEND_CACHE_TTL_MS.marketsHardTtlMs;

  const input: PartialStaleMergeInput = {
    freshData: [],
    v3Succeeded: false,
    v4Succeeded: false,
    staleV3Data: [staleReserve],
    staleV4Data: [],
    v3FetchedAt: now - hardTtl - 60_000,
    v4FetchedAt: null,
    hardTtlMs: hardTtl,
    now,
  };

  const result = mergeWithPartialStale(input);

  assert.equal(
    result.mergedData.length,
    0,
    'When stale is beyond hardTtl, mergedData should be empty (no stale data served)'
  );
});

test('Fix 3: fetchResultOrDefault handles explicit failure envelope from stale fallback', () => {
  const result = getFetchResultOrDefault({
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    dataCount: 0,
    profile: 'test',
    fetchResult: {
      v3: { success: false, source: 'sdk' },
      v4: { success: false, source: 'sdk' },
    },
  });

  assert.equal(result.v3.success, false);
  assert.equal(result.v4.success, false);
  assert.equal(result.v3.source, 'sdk');
  assert.equal(result.v4.source, 'sdk');
});
