import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Minimal V3 market shape for buildMarketsBaseDataset
function makeV3Market(overrides: {
  address?: string;
  chainName?: string;
  chainId?: number;
  tokenSymbol?: string;
  tokenAddress?: string;
  reserveIdSuffix?: string;
} = {}): any {
  const a = overrides;
  return {
    address: a.address ?? '0xv3pool',
    name: 'AaveV3Market',
    chain: {
      name: a.chainName ?? 'Ethereum',
      chainId: a.chainId ?? 1,
    },
    supplyReserves: [
      {
        underlyingToken: {
          symbol: a.tokenSymbol ?? 'USDC',
          name: 'USD Coin',
          address: a.tokenAddress ?? '0xv3usdc',
          decimals: 6,
        },
        aToken: { address: '0xatoken' },
        vToken: { address: '0xvtoken' },
        isFrozen: false,
        isPaused: false,
        size: {
          amount: { raw: '1000000000', value: '1000' },
          usdPerToken: '1',
        },
        borrowInfo: {
          utilizationRate: { value: '0.5' },
          apy: { value: '0.03' },
        },
        supplyInfo: {
          apy: { value: '0.02' },
        },
        incentives: [],
      },
    ],
  };
}

function makeV4Reserve(overrides: {
  reserveId?: string;
  chainName?: string;
  chainId?: number;
  tokenSymbol?: string;
  tokenAddress?: string;
  spokeAddress?: string;
} = {}): any {
  const a = overrides;
  return {
    reserveId: a.reserveId ?? '1:0xspoke:0xv4usdt',
    chainName: a.chainName ?? 'Arbitrum',
    chainId: a.chainId ?? 42161,
    tokenSymbol: a.tokenSymbol ?? 'USDT',
    tokenAddress: a.tokenAddress ?? '0xv4usdt',
    spokeAddress: a.spokeAddress ?? '0xspoke',
    isFrozen: false,
    isPaused: false,
    supplyApy: 0.04,
    borrowApy: 0.06,
  };
}

describe('buildMarketsBaseDataset — pure sync merge', () => {
  it('both success → full merged dataset', async () => {
    const mod = await import('../dist/index.js');
    const fn = mod.buildMarketsBaseDataset;

    const result = fn([makeV3Market()], [makeV4Reserve()]);

    assert.equal(result.v3Count, 1);
    assert.equal(result.v4Count, 1);
    assert.equal(result.baseDataset.length, 2);
    assert.ok(result.baseDataset.find((r: any) => r.tokenSymbol === 'USDC'));
    assert.ok(result.baseDataset.find((r: any) => r.tokenSymbol === 'USDT'));
  });

  it('V3 empty + V4 data → V4 data only (V3 timeout fallback)', async () => {
    const mod = await import('../dist/index.js');
    const fn = mod.buildMarketsBaseDataset;

    const v4 = makeV4Reserve();
    const result = fn([], [v4]);

    assert.equal(result.v3Count, 0);
    assert.equal(result.v4Count, 1);
    assert.equal(result.baseDataset.length, 1);
    assert.equal(result.baseDataset[0].tokenSymbol, 'USDT');
  });

  it('V3 data + V4 empty → V3 data only (V4 timeout fallback)', async () => {
    const mod = await import('../dist/index.js');
    const fn = mod.buildMarketsBaseDataset;

    const result = fn([makeV3Market()], []);

    assert.equal(result.v3Count, 1);
    assert.equal(result.v4Count, 0);
    assert.equal(result.baseDataset.length, 1);
    assert.equal(result.baseDataset[0].tokenSymbol, 'USDC');
  });

  it('both empty → empty baseDataset (both timeout)', async () => {
    const mod = await import('../dist/index.js');
    const fn = mod.buildMarketsBaseDataset;

    const result = fn([], []);

    assert.equal(result.v3Count, 0);
    assert.equal(result.v4Count, 0);
    assert.equal(result.baseDataset.length, 0);
  });

  it('should be synchronous (no Promise return)', async () => {
    const mod = await import('../dist/index.js');
    const fn = mod.buildMarketsBaseDataset;

    const result = fn([makeV3Market()], [makeV4Reserve()]);

    assert.ok(!(result instanceof Promise));
    assert.equal(result.baseDataset.length, 2);
  });
});


describe('fetchV4ReservesWithTimeout — v4Fatal support (DI)', () => {
  it('v4Fatal=false + V4 returns data → success', async () => {
    const mod = await import('../dist/index.js');

    const mockFetchV4 = async () => ({
      mapped: [makeV4Reserve()],
      raw: { reserves: [{}] },
    });

    const result = await mod.fetchV4ReservesWithTimeout({
      v4Fatal: false,
      _fetchV4Fn: mockFetchV4,
    });

    assert.equal(result.mapped.length, 1);
    assert.equal(result.mapped[0].tokenSymbol, 'USDT');
    assert.equal(result.source, 'sdk');
  });

  it('v4Fatal=true + V4 rejects → throws fatal error', async () => {
    const mod = await import('../dist/index.js');

    const mockFetchV4 = async () => {
      throw new Error('V4 SDK down');
    };

    await assert.rejects(
      async () => {
        await mod.fetchV4ReservesWithTimeout({
          v4Fatal: true,
          _fetchV4Fn: mockFetchV4,
        });
      },
      (err: any) => err.message.includes('V4 SDK down'),
      'v4Fatal=true should throw when _fetchV4Fn rejects'
    );
  });

  it('v4Fatal=false + V4 returns empty + RPC empty → fulfills with none', async () => {
    const mod = await import('../dist/index.js');

    const mockFetchV4 = async () => ({
      mapped: [],
      raw: { reserves: [] },
    });

    const result = await mod.fetchV4ReservesWithTimeout({
      v4Fatal: false,
      _fetchV4Fn: mockFetchV4,
      _fetchV4RpcFn: async () => ({ reserves: [], errors: ['empty'] }),
    });

    assert.equal(result.mapped.length, 0);
    assert.equal(result.source, 'none');
    // Should NOT reject — fulfills with empty mapped
  });

  it('v4Fatal=false + V4 SDK rejects + RPC empty → returns empty mapped with source=none', async () => {
    const mod = await import('../dist/index.js');

    const mockFetchV4 = async () => {
      throw new Error('V4 SDK down');
    };

    const result = await mod.fetchV4ReservesWithTimeout({
      v4Fatal: false,
      _fetchV4Fn: mockFetchV4,
      _fetchV4RpcFn: async () => ({ reserves: [], errors: ['empty'] }),
    });

    assert.equal(result.mapped.length, 0);
    assert.equal(result.source, 'none');
  });

  it('v4Fatal=false + V4 SDK rejects + RPC succeeds → returns RPC data', async () => {
    const mod = await import('../dist/index.js');

    const mockFetchV4 = async () => {
      throw new Error('V4 SDK down');
    };

    const result = await mod.fetchV4ReservesWithTimeout({
      v4Fatal: false,
      _fetchV4Fn: mockFetchV4,
      _fetchV4RpcFn: async () => ({
        reserves: [makeV4Reserve({ tokenSymbol: 'RPC-USDT' })],
        errors: [],
      }),
    });

    assert.equal(result.mapped.length, 1);
    assert.equal(result.mapped[0].tokenSymbol, 'RPC-USDT');
    assert.equal(result.source, 'rpc');
  });

  it('v4Fatal=false + V4 SDK rejects + RPC partial errors → returns partial RPC data', async () => {
    const mod = await import('../dist/index.js');

    const mockFetchV4 = async () => {
      throw new Error('V4 SDK down');
    };

    const result = await mod.fetchV4ReservesWithTimeout({
      v4Fatal: false,
      _fetchV4Fn: mockFetchV4,
      _fetchV4RpcFn: async () => ({
        reserves: [makeV4Reserve({ tokenSymbol: 'PARTIAL-USDT' })],
        errors: ['one spoke failed'],
      }),
    });

    assert.equal(result.mapped.length, 1);
    assert.equal(result.mapped[0].tokenSymbol, 'PARTIAL-USDT');
    assert.equal(result.source, 'rpc');
  });

  it('v4Fatal=false + V4 SDK returns empty (no throw) + RPC succeeds → returns RPC data', async () => {
    const mod = await import('../dist/index.js');

    const mockFetchV4 = async () => ({
      mapped: [],
      raw: { reserves: [] },
    });

    const result = await mod.fetchV4ReservesWithTimeout({
      v4Fatal: false,
      _fetchV4Fn: mockFetchV4,
      _fetchV4RpcFn: async () => ({
        reserves: [makeV4Reserve({ tokenSymbol: 'RPC-ETH' })],
        errors: [],
      }),
    });

    assert.equal(result.mapped.length, 1);
    assert.equal(result.mapped[0].tokenSymbol, 'RPC-ETH');
    assert.equal(result.source, 'rpc');
  });
});