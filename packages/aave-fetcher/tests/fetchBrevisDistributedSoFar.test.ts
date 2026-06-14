import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchBrevisDistributedSoFar, __resetBrevisChainCallCacheForTests } from '../src/brevis-distributed-so-far.js';

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
      [`${REAL_CHAIN_ID}-${REAL_TOKEN_ADDR}`, 1.0],
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
      [`${REAL_CHAIN_ID}-${REAL_TOKEN_ADDR}`, 1.0],
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
      [`${REAL_CHAIN_ID}-${REAL_TOKEN_ADDR}`, 1.0],
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
      [`${REAL_CHAIN_ID}-${REAL_TOKEN_ADDR}`, 1.0],
      [`${REAL_CHAIN_ID}-0x0000000000000000000000000000000000000002`, 0.5],
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
