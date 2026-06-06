import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketsBaseDataset, buildV3BaseDataset, fetchV4ReservesWithTimeout, fetchV3MarketsWithTimeout, FETCH_TIMEOUT_MS } from '../src/concurrent-fetch.js';

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

function makeV4FetchResult(mapped: any[] = [], raw: any = { reserves: [] }, spokeHubTopology: any[] = []) {
  return { mapped, raw, spokeHubTopology };
}

describe('buildMarketsBaseDataset — pure sync merge', () => {
  it('both success → full merged dataset', () => {
    const v4Result = makeV4FetchResult([makeV4Reserve()], [{ reserves: [{}] }], []);
    const result = buildMarketsBaseDataset([makeV3Market()], v4Result);

    assert.equal(result.v3Count, 1);
    assert.equal(result.v4Count, 1);
    assert.equal(result.baseDataset.length, 2);
    assert.ok(result.baseDataset.find((r: any) => r.tokenSymbol === 'USDC'));
    assert.ok(result.baseDataset.find((r: any) => r.tokenSymbol === 'USDT'));
  });

  it('V3 empty + V4 data → V4 data only (V3 timeout fallback)', () => {
    const v4 = makeV4Reserve();
    const v4Result = makeV4FetchResult([v4]);
    const result = buildMarketsBaseDataset([], v4Result);

    assert.equal(result.v3Count, 0);
    assert.equal(result.v4Count, 1);
    assert.equal(result.baseDataset.length, 1);
    assert.equal(result.baseDataset[0].tokenSymbol, 'USDT');
  });

  it('V3 data + V4 empty → V3 data only (V4 timeout fallback)', () => {
    const v4Result = makeV4FetchResult([]);
    const result = buildMarketsBaseDataset([makeV3Market()], v4Result);

    assert.equal(result.v3Count, 1);
    assert.equal(result.v4Count, 0);
    assert.equal(result.baseDataset.length, 1);
    assert.equal(result.baseDataset[0].tokenSymbol, 'USDC');
  });

  it('both empty → empty baseDataset (both timeout)', () => {
    const v4Result = makeV4FetchResult([]);
    const result = buildMarketsBaseDataset([], v4Result);

    assert.equal(result.v3Count, 0);
    assert.equal(result.v4Count, 0);
    assert.equal(result.baseDataset.length, 0);
  });

  it('should be synchronous (no Promise return)', () => {
    const v4Result = makeV4FetchResult([makeV4Reserve()]);
    const result = buildMarketsBaseDataset([makeV3Market()], v4Result);

    assert.ok(!(result instanceof Promise));
    assert.equal(result.baseDataset.length, 2);
  });
});

describe('fetchV4ReservesWithTimeout — no v4Fatal (DI)', () => {
  it('V4 returns data → success with source=sdk', async () => {
    const mockFetchV4 = async () => ({
      mapped: [makeV4Reserve()],
      raw: { reserves: [{}] },
      spokeHubTopology: [],
    });

    const result = await fetchV4ReservesWithTimeout({
      _fetchV4Fn: mockFetchV4,
    });

    assert.equal(result.mapped.length, 1);
    assert.equal(result.mapped[0].tokenSymbol, 'USDT');
    assert.equal(result.source, 'sdk');
  });

  it('V4 rejects → throws (caught by Promise.allSettled)', async () => {
    const mockFetchV4 = async () => {
      throw new Error('V4 SDK down');
    };

    await assert.rejects(
      async () => {
        await fetchV4ReservesWithTimeout({
          _fetchV4Fn: mockFetchV4,
        });
      },
      (err: any) => err.message.includes('V4 SDK down'),
      'fetchV4ReservesWithTimeout should throw when _fetchV4Fn rejects'
    );
  });

  it('V4 returns empty → fulfills with empty mapped + source=sdk', async () => {
    const mockFetchV4 = async () => ({
      mapped: [],
      raw: { reserves: [] },
      spokeHubTopology: [],
    });

    const result = await fetchV4ReservesWithTimeout({
      _fetchV4Fn: mockFetchV4,
    });

    assert.equal(result.mapped.length, 0);
    assert.equal(result.source, 'sdk');
  });
});

describe('fetchV3MarketsWithTimeout — DI', () => {
  it('V3 returns data → success', async () => {
    const mockFetchV3 = async () => ({
      markets: [makeV3Market()],
      timestamp: Date.now(),
    });

    const result = await fetchV3MarketsWithTimeout({
      _fetchV3Fn: mockFetchV3,
    });

    assert.ok(result);
    assert.equal(result.markets.length, 1);
  });

  it('V3 rejects → throws', async () => {
    const mockFetchV3 = async () => {
      throw new Error('V3 SDK down');
    };

    await assert.rejects(
      async () => {
        await fetchV3MarketsWithTimeout({
          _fetchV3Fn: mockFetchV3,
        });
      },
      (err: any) => err.message.includes('V3 SDK down'),
      'fetchV3MarketsWithTimeout should throw when _fetchV3Fn rejects'
    );
  });
});

describe('FETCH_TIMEOUT_MS', () => {
  it('should be 35 seconds', () => {
    assert.equal(FETCH_TIMEOUT_MS, 35_000);
  });
});

describe('Promise.allSettled — concurrent V3/V4 scenarios', () => {
  it('both success → full merged dataset', async () => {
    const [v3Settled, v4Settled] = await Promise.allSettled([
      fetchV3MarketsWithTimeout({ _fetchV3Fn: async () => ({ markets: [makeV3Market()], timestamp: new Date().toISOString() }) }),
      fetchV4ReservesWithTimeout({ _fetchV4Fn: async () => makeV4FetchResult([makeV4Reserve()]) }),
    ]);

    assert.equal(v3Settled.status, 'fulfilled');
    assert.equal(v4Settled.status, 'fulfilled');

    const v3Data = (v3Settled as PromiseFulfilledResult<any>).value;
    const v4Data = (v4Settled as PromiseFulfilledResult<any>).value;
    const result = buildMarketsBaseDataset(v3Data.markets, v4Data);

    assert.equal(result.v3Count, 1);
    assert.equal(result.v4Count, 1);
    assert.equal(result.baseDataset.length, 2);
  });

  it('V3 fail + V4 success → V4 data only + fetchResult.v3.success=false', async () => {
    const [v3Settled, v4Settled] = await Promise.allSettled([
      fetchV3MarketsWithTimeout({ _fetchV3Fn: async () => { throw new Error('V3 down'); } }),
      fetchV4ReservesWithTimeout({ _fetchV4Fn: async () => makeV4FetchResult([makeV4Reserve()]) }),
    ]);

    assert.equal(v3Settled.status, 'rejected');
    assert.equal(v4Settled.status, 'fulfilled');

    const v4Data = (v4Settled as PromiseFulfilledResult<any>).value;
    const result = buildMarketsBaseDataset([], v4Data);

    assert.equal(result.v3Count, 0);
    assert.equal(result.v4Count, 1);
  });

  it('V3 success + V4 fail → V3 data only + fetchResult.v4.success=false', async () => {
    const [v3Settled, v4Settled] = await Promise.allSettled([
      fetchV3MarketsWithTimeout({ _fetchV3Fn: async () => ({ markets: [makeV3Market()], timestamp: new Date().toISOString() }) }),
      fetchV4ReservesWithTimeout({ _fetchV4Fn: async () => { throw new Error('V4 down'); } }),
    ]);

    assert.equal(v3Settled.status, 'fulfilled');
    assert.equal(v4Settled.status, 'rejected');

    const v3Data = (v3Settled as PromiseFulfilledResult<any>).value;
    const result = buildMarketsBaseDataset(v3Data.markets, makeV4FetchResult([]));

    assert.equal(result.v3Count, 1);
    assert.equal(result.v4Count, 0);
  });

  it('both fail → should throw in caller', async () => {
    const [v3Settled, v4Settled] = await Promise.allSettled([
      fetchV3MarketsWithTimeout({ _fetchV3Fn: async () => { throw new Error('V3 down'); } }),
      fetchV4ReservesWithTimeout({ _fetchV4Fn: async () => { throw new Error('V4 down'); } }),
    ]);

    assert.equal(v3Settled.status, 'rejected');
    assert.equal(v4Settled.status, 'rejected');
  });

  it('fetchResult envelope shape', async () => {
    const [v3Settled, v4Settled] = await Promise.allSettled([
      fetchV3MarketsWithTimeout({ _fetchV3Fn: async () => ({ markets: [makeV3Market()], timestamp: new Date().toISOString() }) }),
      fetchV4ReservesWithTimeout({ _fetchV4Fn: async () => makeV4FetchResult([makeV4Reserve()]) }),
    ]);

    const v3Success = v3Settled.status === 'fulfilled';
    const v4Success = v4Settled.status === 'fulfilled';
    const fetchResult = {
      v3: { success: v3Success, source: v3Success ? 'sdk' : 'none' },
      v4: { success: v4Success, source: v4Success ? 'sdk' : 'none' },
    };

    assert.deepEqual(fetchResult, {
      v3: { success: true, source: 'sdk' },
      v4: { success: true, source: 'sdk' },
    });
  });
});
