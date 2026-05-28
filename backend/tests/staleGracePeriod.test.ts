import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKEND_CACHE_TTL_MS, BACKEND_TIME_MS } from '../src/cacheTtl.js';
import { mergeWithPartialStale, getFetchResultOrDefault } from '../src/services/marketsService.js';
import type { PartialStaleMergeInput } from '../src/services/marketsService.js';
import type { RuntimeReserveData } from '@internal/aave-shared-contracts';

test('Fix 5: marketsHardTtlMs is 10 minutes (not 5)', () => {
  assert.equal(
    BACKEND_CACHE_TTL_MS.marketsHardTtlMs,
    BACKEND_TIME_MS.tenMinutes,
    'hardTtl should be 10min to give 2x buffer over 5min softTtl'
  );
  assert.equal(BACKEND_CACHE_TTL_MS.marketsHardTtlMs, 10 * 60 * 1000);
});

test('Fix 2: stale snapshot still returns payload (not null) — mergeWithPartialStale preserves data', () => {
  const staleReserve: RuntimeReserveData = {
    reserveId: '1:0xpool:0xusdc',
    chainName: 'Ethereum',
    chainId: 1,
    tokenSymbol: 'USDC',
    tokenName: 'USD Coin',
    decimals: 6,
    price: 1n,
    priceDecimals: 8,
    supplyAPY: 0.02,
    variableBorrowAPY: 0.05,
    stableBorrowAPY: null,
    liquidity: 1000000n,
    totalDebt: 500000n,
    totalStableDebt: 0n,
    totalVariableDebt: 500000n,
    utilization: 0.5,
    availableBorrow: 500000n,
    ltv: 0.85,
    liquidationThreshold: 0.9,
    liquidationBonus: 0.05,
    reserveFactor: 0.1,
    aTokenAddress: '0xaToken',
    variableDebtTokenAddress: '0xvarDebt',
    stableDebtTokenAddress: null,
    isFrozen: false,
    isPaused: false,
    borrowable: true,
    isIsolated: false,
    debtCeiling: null,
    debtCeilingDecimals: null,
    eMode: null,
    isSiloed: false,
    isFlashLoanEnabled: true,
    supplyCap: null,
    borrowCap: null,
    isFlashLoanDisabled: false,
    eModeCategory: null,
    underlyingTokenAddress: '0xusdc',
    isDeprecated: false,
    supplyIncentiveApr: 0,
    variableBorrowIncentiveApr: 0,
    stableBorrowIncentiveApr: 0,
    isEntitled: false,
  };

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
  const staleReserve: RuntimeReserveData = {
    reserveId: '1:0xpool:0xdai',
    chainName: 'Ethereum',
    chainId: 1,
    tokenSymbol: 'DAI',
    tokenName: 'Dai Stablecoin',
    decimals: 18,
    price: 1n,
    priceDecimals: 8,
    supplyAPY: 0.03,
    variableBorrowAPY: 0.06,
    stableBorrowAPY: null,
    liquidity: 2000000n,
    totalDebt: 1000000n,
    totalStableDebt: 0n,
    totalVariableDebt: 1000000n,
    utilization: 0.5,
    availableBorrow: 1000000n,
    ltv: 0.8,
    liquidationThreshold: 0.85,
    liquidationBonus: 0.05,
    reserveFactor: 0.1,
    aTokenAddress: '0xaToken2',
    variableDebtTokenAddress: '0xvarDebt2',
    stableDebtTokenAddress: null,
    isFrozen: false,
    isPaused: false,
    borrowable: true,
    isIsolated: false,
    debtCeiling: null,
    debtCeilingDecimals: null,
    eMode: null,
    isSiloed: false,
    isFlashLoanEnabled: true,
    supplyCap: null,
    borrowCap: null,
    isFlashLoanDisabled: false,
    eModeCategory: null,
    underlyingTokenAddress: '0xdai',
    isDeprecated: false,
    supplyIncentiveApr: 0,
    variableBorrowIncentiveApr: 0,
    stableBorrowIncentiveApr: 0,
    isEntitled: false,
  };

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
