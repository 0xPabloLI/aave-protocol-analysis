import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectNetPositionConstraint } from '../src/merkl-api.js';
import type { MerklOpportunityData, NetPositionConstraint } from '../src/merkl-api.js';
import type { LlmAnalysisResult } from '../src/merklLlmClient.js';
import type { RuntimeReserveData } from '@internal/aave-shared-contracts';

const makeReserveLookup = (reserves: Partial<RuntimeReserveData>[]): Map<string, { reserveId: string; tokenSymbol?: string }[]> => {
  const map = new Map<string, { reserveId: string; tokenSymbol?: string }[]>();
  for (const r of reserves) {
    const key = `${r.chainId}:${(r.tokenAddress ?? '').toLowerCase()}`;
    const entry = { reserveId: r.reserveId ?? '', tokenSymbol: r.tokenSymbol };
    const existing = map.get(key);
    if (existing) { existing.push(entry); } else { map.set(key, [entry]); }
  }
  return map;
};

describe('B4: detectNetPositionConstraint — three-layer detection', () => {

  it('Layer 1 returns constraint for AAVE_NET_LENDING', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Plasma', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_NET_LENDING',
      offsetTokenAddresses: [
        { address: '0xusde', reserveId: '1:0xpool:0xusde' },
        { address: '0xgho', reserveId: '1:0xpool:0xgho' },
      ],
    };
    const result = await detectNetPositionConstraint(opp, '0xusdt', makeReserveLookup([]));
    assert.deepEqual(result, { sourceSide: 'supply', offsetReserveIds: ['1:0xpool:0xusde', '1:0xpool:0xgho'] });
  });

  it('Layer 2 returns cached constraint when Layer 1 returns null', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
      description: 'USDT0 supply minus USDT0, USDe, GHO borrows',
    };
    const cached: NetPositionConstraint = { sourceSide: 'supply', offsetReserveIds: ['1:0xpool:0xusde'] };
    const result = await detectNetPositionConstraint(opp, '0xusdt0', makeReserveLookup([]), cached);
    assert.deepEqual(result, cached);
  });

  it('Layer 3 LLM fallback when Layer 1 null + no cache', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
      description: 'USDtb supply — borrowers excluded',
    };
    const lookup = makeReserveLookup([
      { reserveId: '1:0xpool:0xusdtb', chainId: 1, tokenAddress: '0xusdtb', tokenSymbol: 'USDtb' },
    ]);
    const mockLlm = async (): Promise<LlmAnalysisResult | null> => ({
      sourceSide: 'supply',
      offsetTokenSymbols: ['USDtb'],
    });
    const result = await detectNetPositionConstraint(opp, '0xusdtb', lookup, undefined, mockLlm);
    assert.deepEqual(result, { sourceSide: 'supply', offsetReserveIds: ['1:0xpool:0xusdtb'] });
  });

  it('Layer 3 LLM returns null when LLM says null', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
    };
    const mockLlm = async (): Promise<LlmAnalysisResult | null> => null;
    const result = await detectNetPositionConstraint(opp, '0xusdt', makeReserveLookup([]), undefined, mockLlm);
    assert.equal(result, null);
  });

  it('returns null when all layers fail and no LLM provided', async () => {
    const opp: MerklOpportunityData = {
      supply: [], borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
    };
    const result = await detectNetPositionConstraint(opp, '0xusdt', makeReserveLookup([]));
    assert.equal(result, null);
  });

  it('LLM offsetTokenSymbols resolved via reserveLookup (symbol→address→reserveId)', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'MULTILOG_DUTCH',
      description: 'USDC borrow minus USDC supply',
    };
    const lookup = makeReserveLookup([
      { reserveId: '1:0xpool:0xusdc', chainId: 1, tokenAddress: '0xusdc', tokenSymbol: 'USDC' },
    ]);
    const mockLlm = async (): Promise<LlmAnalysisResult | null> => ({
      sourceSide: 'borrow',
      offsetTokenSymbols: ['USDC'],
    });
    const result = await detectNetPositionConstraint(opp, '0xusdc', lookup, undefined, mockLlm);
    assert.deepEqual(result, { sourceSide: 'borrow', offsetReserveIds: ['1:0xpool:0xusdc'] });
  });

  it('Bug3: AAVE_NET_LENDING includes self token as offset (same-token net position)', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3MegaETH', chainId: 4326, protocolVersion: 'v3',
      opportunityType: 'AAVE_NET_LENDING',
      offsetTokenAddresses: [{ address: '0xusdm', reserveId: '4326:0xpool:0xusdm' }],
    };
    const result = await detectNetPositionConstraint(opp, '0xusdm', makeReserveLookup([]));
    assert.deepEqual(result, { sourceSide: 'supply', offsetReserveIds: ['4326:0xpool:0xusdm'] });
  });

  it('Bug3: AAVE_NET_BORROWING includes self token as offset', async () => {
    const opp: MerklOpportunityData = {
      supply: [], borrow: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_NET_BORROWING',
      offsetTokenAddresses: [{ address: '0xgho', reserveId: '1:0xpool:0xgho' }],
    };
    const result = await detectNetPositionConstraint(opp, '0xgho', makeReserveLookup([]));
    assert.deepEqual(result, { sourceSide: 'borrow', offsetReserveIds: ['1:0xpool:0xgho'] });
  });

  it('Bug3: AAVE_NET_LENDING with cross+same tokens includes self and others', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_NET_LENDING',
      offsetTokenAddresses: [
        { address: '0xusde', reserveId: '1:0xpool:0xusde' },
        { address: '0xgho', reserveId: '1:0xpool:0xgho' },
      ],
    };
    const result = await detectNetPositionConstraint(opp, '0xusde', makeReserveLookup([]));
    assert.deepEqual(result, { sourceSide: 'supply', offsetReserveIds: ['1:0xpool:0xusde', '1:0xpool:0xgho'] });
  });

  it('LLM returns null when offsetTokenSymbols not found in lookup', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
    };
    const mockLlm = async (): Promise<LlmAnalysisResult | null> => ({
      sourceSide: 'supply',
      offsetTokenSymbols: ['UNKNOWN_TOKEN'],
    });
    const result = await detectNetPositionConstraint(opp, '0xusdt', makeReserveLookup([]), undefined, mockLlm);
    assert.equal(result, null);
  });

  it('V3/V4 collision: V3 opp resolves V3 reserveId, not V4', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3EthereumHorizon', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_NET_LENDING',
      offsetTokenAddresses: [
        { address: '0xrlusd' },
      ],
    };
    const lookup = makeReserveLookup([
      { reserveId: '1:0xv3pool:0xrlusd', chainId: 1, tokenAddress: '0xrlusd', tokenSymbol: 'RLUSD' },
      { reserveId: '1:0xv4spoke:0xrlusd:Core', chainId: 1, tokenAddress: '0xrlusd', tokenSymbol: 'RLUSD' },
    ]);
    const result = await detectNetPositionConstraint(opp, '0xrlusd', lookup);
    assert.deepEqual(result, { sourceSide: 'supply', offsetReserveIds: ['1:0xv3pool:0xrlusd'] });
  });

  it('V3/V4 collision: V4 opp resolves V4 reserveId', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV4Ethereum', chainId: 1, protocolVersion: 'v4',
      opportunityType: 'AAVE_NET_LENDING',
      offsetTokenAddresses: [
        { address: '0xrlusd' },
      ],
    };
    const lookup = makeReserveLookup([
      { reserveId: '1:0xv3pool:0xrlusd', chainId: 1, tokenAddress: '0xrlusd', tokenSymbol: 'RLUSD' },
      { reserveId: '1:0xv4spoke:0xrlusd:Core', chainId: 1, tokenAddress: '0xrlusd', tokenSymbol: 'RLUSD' },
    ]);
    const result = await detectNetPositionConstraint(opp, '0xrlusd', lookup);
    assert.deepEqual(result, { sourceSide: 'supply', offsetReserveIds: ['1:0xv4spoke:0xrlusd:Core'] });
  });

  it('V3/V4 collision: LLM fallback filters by protocolVersion', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
    };
    const lookup = makeReserveLookup([
      { reserveId: '1:0xv3pool:0xusdc', chainId: 1, tokenAddress: '0xusdc', tokenSymbol: 'USDC' },
      { reserveId: '1:0xv4spoke:0xusdc:Core', chainId: 1, tokenAddress: '0xusdc', tokenSymbol: 'USDC' },
    ]);
    const mockLlm = async (): Promise<LlmAnalysisResult | null> => ({
      sourceSide: 'borrow',
      offsetTokenSymbols: ['USDC'],
    });
    const result = await detectNetPositionConstraint(opp, '0xusdc', lookup, undefined, mockLlm);
    assert.deepEqual(result, { sourceSide: 'borrow', offsetReserveIds: ['1:0xv3pool:0xusdc'] });
  });

});
