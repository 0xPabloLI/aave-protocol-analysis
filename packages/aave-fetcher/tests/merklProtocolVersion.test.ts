import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildProtocolVersionLookup, deriveProtocolVersion } from '../src/merkl-api.js';

// Minimal mock reserve matching the shape buildProtocolVersionLookup expects
function mockReserve(overrides: Partial<{
  marketName: string;
  chainId: number;
  aTokenAddress: string;
  vTokenAddress: string;
  spokeAddress: string;
  tokenAddress: string;
}> = {}) {
  return {
    marketName: overrides.marketName ?? 'AaveV3Ethereum',
    chainId: overrides.chainId ?? 1,
    aTokenAddress: overrides.aTokenAddress,
    vTokenAddress: overrides.vTokenAddress,
    spokeAddress: overrides.spokeAddress,
    tokenAddress: overrides.tokenAddress,
    // Fields required by RuntimeReserveData but not used by lookup builder
    reserveId: 'test-reserve-id',
    symbol: 'TEST',
    name: 'Test Token',
    decimals: 18,
    totalSupply: '0',
    totalSupplyRaw: '0',
    totalVariableDebt: '0',
    totalVariableDebtRaw: '0',
    baseLTVasCollateral: '0',
    variableBorrowRate: '0',
    variableBorrowRateRaw: '0',
    liquidityRate: '0',
    liquidityRateRaw: '0',
    liquidityIndex: '0',
    liquidityIndexRaw: '0',
    variableBorrowIndex: '0',
    variableBorrowIndexRaw: '0',
    priceInMarketReferenceCurrency: '0',
    usageAsCollateralEnabled: false,
    isFrozen: false,
    isPaused: false,
    borrowingEnabled: false,
    reserveLiquidationThreshold: '0',
    optimalUsageRatio: '0',
    maxVariableBorrowRate: '0',
    maxVariableBorrowRateRaw: '0',
    supplyCap: '0',
    borrowCap: '0',
  };
}

describe('buildProtocolVersionLookup', () => {
  it('builds empty lookup for empty dataset', () => {
    const { unambiguous, v4Underlying } = buildProtocolVersionLookup([]);
    assert.equal(unambiguous.size, 0);
    assert.equal(v4Underlying.size, 0);
  });

  it('adds V3 aToken and vToken to unambiguous lookup', () => {
    const { unambiguous } = buildProtocolVersionLookup([
      mockReserve({
        marketName: 'AaveV3Ethereum',
        chainId: 1,
        aTokenAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        vTokenAddress: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      }),
    ]);
    assert.equal(unambiguous.size, 2);
    assert.equal(unambiguous.get('1:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), 'v3');
    assert.equal(unambiguous.get('1:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), 'v3');
  });

  it('adds V4 aToken, vToken, and spoke to unambiguous lookup', () => {
    const { unambiguous } = buildProtocolVersionLookup([
      mockReserve({
        marketName: 'AaveV4EthereumCore',
        chainId: 1,
        aTokenAddress: '0xAAAAA00000000000000000000000000000000000',
        vTokenAddress: '0xBBBBB00000000000000000000000000000000000',
        spokeAddress: '0xCCCCC00000000000000000000000000000000000',
      }),
    ]);
    assert.equal(unambiguous.size, 3);
    assert.equal(unambiguous.get('1:0xaaaaa00000000000000000000000000000000000'), 'v4');
    assert.equal(unambiguous.get('1:0xbbbbb00000000000000000000000000000000000'), 'v4');
    assert.equal(unambiguous.get('1:0xccccc00000000000000000000000000000000000'), 'v4');
  });

  it('adds V4 underlying token to v4Underlying lookup only', () => {
    const { unambiguous, v4Underlying } = buildProtocolVersionLookup([
      mockReserve({
        marketName: 'AaveV4EthereumCore',
        chainId: 1,
        tokenAddress: '0xUSDG000000000000000000000000000000000000',
      }),
    ]);
    // V3 underlying token should NOT be in v4Underlying
    assert.equal(v4Underlying.size, 1);
    assert.equal(v4Underlying.get('1:0xusdg000000000000000000000000000000000000'), true);
    // underlying token should NOT be in unambiguous
    assert.equal(unambiguous.has('1:0xusdg000000000000000000000000000000000000'), false);
  });

  it('does NOT add V3 underlying token to v4Underlying', () => {
    const { v4Underlying } = buildProtocolVersionLookup([
      mockReserve({
        marketName: 'AaveV3Ethereum',
        chainId: 1,
        tokenAddress: '0xUSDG000000000000000000000000000000000000',
      }),
    ]);
    assert.equal(v4Underlying.size, 0);
  });

  it('handles multiple reserves across chains', () => {
    const { unambiguous } = buildProtocolVersionLookup([
      mockReserve({
        marketName: 'AaveV3Ethereum',
        chainId: 1,
        aTokenAddress: '0xAAA1110000000000000000000000000000000000',
      }),
      mockReserve({
        marketName: 'AaveV4ArbitrumCore',
        chainId: 42161,
        aTokenAddress: '0xAAA2220000000000000000000000000000000000',
      }),
    ]);
    assert.equal(unambiguous.get('1:0xaaa1110000000000000000000000000000000000'), 'v3');
    assert.equal(unambiguous.get('42161:0xaaa2220000000000000000000000000000000000'), 'v4');
  });
});

describe('deriveProtocolVersion', () => {
  const emptyLookup = () => ({
    unambiguous: new Map<string, 'v3' | 'v4'>(),
    v4Underlying: new Map<string, true>(),
  });
  const v3Lookup = () => {
    const unambiguous = new Map<string, 'v3' | 'v4'>();
    unambiguous.set('1:0xaaa1110000000000000000000000000000000000', 'v3');
    return { unambiguous, v4Underlying: new Map<string, true>() };
  };
  const v4SpokeLookup = () => {
    const unambiguous = new Map<string, 'v3' | 'v4'>();
    unambiguous.set('1:0xspoke000000000000000000000000000000000000', 'v4');
    return { unambiguous, v4Underlying: new Map<string, true>() };
  };
  const v4UnderlyingLookup = () => {
    const v4Underlying = new Map<string, true>();
    v4Underlying.set('1:0xusdg000000000000000000000000000000000000', true);
    return { unambiguous: new Map<string, 'v3' | 'v4'>(), v4Underlying };
  };

  // --- Step 1: type prefix ---
  it('returns v4 when type starts with AAVE_V4_ (step 1)', () => {
    const { unambiguous, v4Underlying } = emptyLookup();
    assert.equal(
      deriveProtocolVersion('AAVE_V4_HUB_SUPPLY', '0xunknown', 1, unambiguous, v4Underlying),
      'v4',
    );
    assert.equal(
      deriveProtocolVersion('AAVE_V4_SPOKE_SUPPLY', '0xunknown', 1, unambiguous, v4Underlying),
      'v4',
    );
    assert.equal(
      deriveProtocolVersion('aave_v4_something', '0xunknown', 1, unambiguous, v4Underlying),
      'v4',
    );
  });

  it('returns v4 when type is AAVE_V4_ regardless of explorerAddress (step 1)', () => {
    const { unambiguous, v4Underlying } = emptyLookup();
    // Even with a V3 aToken in lookup, type takes priority
    const u = new Map<string, 'v3' | 'v4'>();
    u.set('1:0xaaa1110000000000000000000000000000000000', 'v3');
    assert.equal(
      deriveProtocolVersion('AAVE_V4_HUB_SUPPLY', '0xaaa1110000000000000000000000000000000000', 1, u, new Map()),
      'v4',
    );
  });

  // --- No explorerAddress ---
  it('returns v3 when no explorerAddress and no V4 type (step 4)', () => {
    const { unambiguous, v4Underlying } = emptyLookup();
    assert.equal(
      deriveProtocolVersion('AAVE_NET_LENDING', undefined, 1, unambiguous, v4Underlying),
      'v3',
    );
  });

  // --- Step 2: unambiguous lookup ---
  it('matches V3 reserve via aToken address (step 2)', () => {
    const { unambiguous, v4Underlying } = v3Lookup();
    assert.equal(
      deriveProtocolVersion('AAVE_NET_LENDING', '0xAAA1110000000000000000000000000000000000', 1, unambiguous, v4Underlying),
      'v3',
    );
  });

  it('matches V4 reserve via spoke address (step 2)', () => {
    const { unambiguous, v4Underlying } = v4SpokeLookup();
    assert.equal(
      deriveProtocolVersion('ERC20_MAPPING', '0xSPOKE000000000000000000000000000000000000', 1, unambiguous, v4Underlying),
      'v4',
    );
  });

  it('lookup is case-insensitive (step 2)', () => {
    const { unambiguous, v4Underlying } = v3Lookup();
    assert.equal(
      deriveProtocolVersion('AAVE_NET_LENDING', '0xaaa1110000000000000000000000000000000000', 1, unambiguous, v4Underlying),
      'v3',
    );
  });

  // --- Step 3: V4 underlying token ---
  it('matches V4 underlying token lookup (step 3)', () => {
    const { unambiguous, v4Underlying } = v4UnderlyingLookup();
    assert.equal(
      deriveProtocolVersion('AAVE_SUPPLY', '0xUSDG000000000000000000000000000000000000', 1, unambiguous, v4Underlying),
      'v4',
    );
  });

  it('does NOT match underlying token when not in v4Underlying (step 4 default)', () => {
    const { unambiguous, v4Underlying } = emptyLookup();
    assert.equal(
      deriveProtocolVersion('AAVE_SUPPLY', '0xUSDG000000000000000000000000000000000000', 1, unambiguous, v4Underlying),
      'v3',
    );
  });

  // --- Step 4: default ---
  it('returns v3 when nothing matches (step 4)', () => {
    const { unambiguous, v4Underlying } = emptyLookup();
    assert.equal(
      deriveProtocolVersion('UNKNOWN_TYPE', '0xdeadbeef00000000000000000000000000000000', 1, unambiguous, v4Underlying),
      'v3',
    );
  });

  it('returns v3 for undefined type (step 4)', () => {
    const { unambiguous, v4Underlying } = emptyLookup();
    assert.equal(
      deriveProtocolVersion(undefined, '0xunknown', 1, unambiguous, v4Underlying),
      'v3',
    );
  });

  // --- Chain ID isolation ---
  it('does NOT match across different chain IDs', () => {
    const { unambiguous } = v3Lookup();
    const v4Underlying = new Map<string, true>();
    assert.equal(
      deriveProtocolVersion('AAVE_NET_LENDING', '0xaaa1110000000000000000000000000000000000', 137, unambiguous, v4Underlying),
      'v3',
    );
  });
});