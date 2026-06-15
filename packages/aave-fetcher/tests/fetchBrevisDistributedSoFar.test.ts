import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchBrevisDistributedSoFar, __resetBrevisChainCallCacheForTests } from '../src/brevis-distributed-so-far.js';
import type { ProviderPoolLike } from '@internal/aave-rpc-infra';
import type { Multicall3Call } from '@internal/aave-rpc-infra';
import { chainTokenKey } from '@internal/aave-shared-contracts';

const OPTIMISM_RPC = 'https://optimism-rpc.publicnode.com';

const REAL_SUBMIT_ADDR = '0x12453465af7404b004984a36138081e49d4a4208';
const REAL_SUBMIT_CHAIN_ID = 10;
const REAL_TOKEN_ADDR = '0x176211869ca2b568f2a7d4ee941e073a821ee1ff';
const REAL_CHAIN_ID = 59144;
const REAL_DECIMALS = 6;
const REAL_CAMPAIGN_ID = '1754995104';

describe('fetchBrevisDistributedSoFar', () => {
  beforeEach(() => {
    __resetBrevisChainCallCacheForTests();
  });

  describe('ProviderPool', () => {

  it('calls executeWithAutoRpc with correct chainId', async () => {
    let capturedChainId: number | undefined;
    const mockPool: ProviderPoolLike = {
      getProvidersForChain: () => [],
      reportProviderFailure: () => {},
      reportProviderSuccess: () => {},
      errorClassifier: () => 'retry_next_rpc' as const,
      executeWithAutoRpc: async <T,>(chainId: number) => {
        capturedChainId = chainId;
        return null as unknown as T;
      },
    };

    const campaigns = [
      {
        campaignId: 'test-1',
        submitAddr: REAL_SUBMIT_ADDR,
        submitChainId: REAL_SUBMIT_CHAIN_ID,
        tokenAddr: REAL_TOKEN_ADDR,
        decimals: REAL_DECIMALS,
        chainId: REAL_CHAIN_ID,
      },
    ];
    const tokenPrices = new Map<string, number>();

    await fetchBrevisDistributedSoFar(campaigns, tokenPrices, {
      providerPool: mockPool,
    });

    assert.equal(capturedChainId, REAL_SUBMIT_CHAIN_ID);
  });

  it('returns undefined when executeWithAutoRpc returns null', async () => {
    const mockPool: ProviderPoolLike = {
      getProvidersForChain: () => [],
      reportProviderFailure: () => {},
      reportProviderSuccess: () => {},
      errorClassifier: () => 'retry_next_rpc' as const,
      executeWithAutoRpc: async () => null,
    };

    const campaigns = [
      {
        campaignId: 'null-result-1',
        submitAddr: REAL_SUBMIT_ADDR,
        submitChainId: REAL_SUBMIT_CHAIN_ID,
        tokenAddr: REAL_TOKEN_ADDR,
        decimals: REAL_DECIMALS,
        chainId: REAL_CHAIN_ID,
      },
    ];
    const tokenPrices = new Map<string, number>([
      [chainTokenKey(REAL_CHAIN_ID, REAL_TOKEN_ADDR), 1.0],
    ]);

    const result = await fetchBrevisDistributedSoFar(campaigns, tokenPrices, {
      providerPool: mockPool,
    });

    assert.equal(result.get('null-result-1'), undefined);
  });

  it('passes multicall calls through executeWithAutoRpc primary callback', async () => {
    let primaryCalled = false;
    let capturedCalls: Multicall3Call[] = [];
    const mockPool: ProviderPoolLike = {
      getProvidersForChain: () => [],
      reportProviderFailure: () => {},
      reportProviderSuccess: () => {},
      errorClassifier: () => 'retry_next_rpc' as const,
      executeWithAutoRpc: async <T,>(_chainId: number, execs: { primary: (provider: any) => Promise<T> }) => {
        primaryCalled = true;
        try {
          const result = await execs.primary({} as any);
          return result;
        } catch {
          return null;
        }
      },
    };

    const campaigns = [
      {
        campaignId: 'mock-1',
        submitAddr: '0x12453465af7404b004984a36138081e49d4a4208',
        submitChainId: 10,
        tokenAddr: REAL_TOKEN_ADDR,
        decimals: REAL_DECIMALS,
        chainId: REAL_CHAIN_ID,
      },
    ];
    const tokenPrices = new Map<string, number>([
      [chainTokenKey(REAL_CHAIN_ID, REAL_TOKEN_ADDR), 1.0],
    ]);

    await fetchBrevisDistributedSoFar(campaigns, tokenPrices, {
      providerPool: mockPool,
      _mockExecuteMulticall3: async (_provider, calls) => {
        capturedCalls = calls;
        return [
          { success: true, returnData: '0x0000000000000000000000000000000000000000000000000000000000f4240' },
        ];
      },
    });

    assert.equal(primaryCalled, true, 'primary callback should be invoked via executeWithAutoRpc');
    assert.equal(capturedCalls.length, 1, 'should pass one multicall call');
    assert.equal(capturedCalls[0]?.target, '0x12453465af7404b004984a36138081e49d4a4208');
    assert.ok(capturedCalls[0]?.callData.startsWith('0xd4f3c7cc'), 'callData should start with tokenCumulativeRewards selector');
  });

  it('returns undefined when no providerPool provided', async () => {
    const campaigns = [
      {
        campaignId: 'no-pool-1',
        submitAddr: REAL_SUBMIT_ADDR,
        submitChainId: REAL_SUBMIT_CHAIN_ID,
        tokenAddr: REAL_TOKEN_ADDR,
        decimals: REAL_DECIMALS,
        chainId: REAL_CHAIN_ID,
      },
    ];
    const tokenPrices = new Map<string, number>();

    const result = await fetchBrevisDistributedSoFar(campaigns, tokenPrices, {});

    assert.equal(result.get('no-pool-1'), undefined);
  });
});

  describe('integration', () => {
  it('returns distributedSoFarUsd for real Brevis campaign on Optimism', async () => {
    const campaigns = [
      {
        campaignId: REAL_CAMPAIGN_ID,
        submitAddr: REAL_SUBMIT_ADDR,
        submitChainId: REAL_SUBMIT_CHAIN_ID,
        tokenAddr: REAL_TOKEN_ADDR,
        decimals: REAL_DECIMALS,
        chainId: REAL_CHAIN_ID,
      },
    ];
    const tokenPrices = new Map<string, number>([
      [chainTokenKey(REAL_CHAIN_ID, REAL_TOKEN_ADDR), 1.0],
    ]);

    const result = await fetchBrevisDistributedSoFar(campaigns, tokenPrices, {
      rpcUrlsByChainId: { [REAL_SUBMIT_CHAIN_ID]: [OPTIMISM_RPC] },
    });

    assert.equal(result.has(REAL_CAMPAIGN_ID), true);
    const val = result.get(REAL_CAMPAIGN_ID);
    assert.equal(typeof val, 'number', 'should be a number for a valid campaign');
    assert.ok(val! > 0, 'should be positive for an active campaign');
    assert.ok(val! < 20_000_000, 'should be less than total budget (10M USDC)');
  });

  it('returns undefined for invalid submit contract', async () => {
    const campaigns = [
      {
        campaignId: 'invalid-1',
        submitAddr: '0x0000000000000000000000000000000000000001',
        submitChainId: 10,
        tokenAddr: REAL_TOKEN_ADDR,
        decimals: 6,
        chainId: REAL_CHAIN_ID,
      },
    ];
    const tokenPrices = new Map<string, number>([
      [chainTokenKey(REAL_CHAIN_ID, REAL_TOKEN_ADDR), 1.0],
    ]);

    const result = await fetchBrevisDistributedSoFar(campaigns, tokenPrices, {
      rpcUrlsByChainId: { 10: [OPTIMISM_RPC] },
    });

    assert.equal(result.get('invalid-1'), undefined);
  });

  it('returns undefined for unsupported chain', async () => {
    const campaigns = [
      {
        campaignId: 'unsupported-1',
        submitAddr: '0x12453465af7404b004984a36138081e49d4a4208',
        submitChainId: 99999,
        tokenAddr: REAL_TOKEN_ADDR,
        decimals: 6,
        chainId: REAL_CHAIN_ID,
      },
    ];
    const tokenPrices = new Map<string, number>([
      [chainTokenKey(REAL_CHAIN_ID, REAL_TOKEN_ADDR), 1.0],
    ]);

    const result = await fetchBrevisDistributedSoFar(campaigns, tokenPrices, {
      rpcUrlsByChainId: {},
    });

    assert.equal(result.get('unsupported-1'), undefined);
  });

  it('handles multiple campaigns on same chain via Multicall3 batch', async () => {
    const campaigns = [
      {
        campaignId: REAL_CAMPAIGN_ID,
        submitAddr: REAL_SUBMIT_ADDR,
        submitChainId: REAL_SUBMIT_CHAIN_ID,
        tokenAddr: REAL_TOKEN_ADDR,
        decimals: REAL_DECIMALS,
        chainId: REAL_CHAIN_ID,
      },
      {
        campaignId: 'same-chain-diff-token',
        submitAddr: REAL_SUBMIT_ADDR,
        submitChainId: REAL_SUBMIT_CHAIN_ID,
        tokenAddr: '0x0000000000000000000000000000000000000002',
        decimals: 18,
        chainId: REAL_CHAIN_ID,
      },
    ];
    const tokenPrices = new Map<string, number>([
      [chainTokenKey(REAL_CHAIN_ID, REAL_TOKEN_ADDR), 1.0],
      [chainTokenKey(REAL_CHAIN_ID, '0x0000000000000000000000000000000000000002'), 0.5],
    ]);

    const result = await fetchBrevisDistributedSoFar(campaigns, tokenPrices, {
      rpcUrlsByChainId: { [REAL_SUBMIT_CHAIN_ID]: [OPTIMISM_RPC] },
    });

    assert.ok(result.has(REAL_CAMPAIGN_ID));
    assert.equal(result.has('same-chain-diff-token'), true);
    assert.equal(typeof result.get(REAL_CAMPAIGN_ID), 'number');
    assert.ok(result.get(REAL_CAMPAIGN_ID)! > 0);
    assert.equal(result.get('same-chain-diff-token'), 0, 'unknown token returns 0 from contract (success=true, returnData=0)');
  });

  it('returns undefined when token price is missing', async () => {
    const campaigns = [
      {
        campaignId: REAL_CAMPAIGN_ID,
        submitAddr: REAL_SUBMIT_ADDR,
        submitChainId: REAL_SUBMIT_CHAIN_ID,
        tokenAddr: REAL_TOKEN_ADDR,
        decimals: REAL_DECIMALS,
        chainId: REAL_CHAIN_ID,
      },
    ];
    const tokenPrices = new Map<string, number>();

    const result = await fetchBrevisDistributedSoFar(campaigns, tokenPrices, {
      rpcUrlsByChainId: { [REAL_SUBMIT_CHAIN_ID]: [OPTIMISM_RPC] },
    });

    assert.equal(result.get(REAL_CAMPAIGN_ID), undefined);
  });
  });
});
