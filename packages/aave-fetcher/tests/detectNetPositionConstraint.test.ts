import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectNetPositionConstraint, detectNetPositionByHeuristic } from '../src/merkl-api.js';
import type { MerklOpportunityData, NetPositionConstraint } from '../src/merkl-api.js';
import type { LlmAnalysisResult } from '../src/merklLlmClient.js';

const makeReserveIdSet = (reserveIds: string[]): Set<string> => new Set(reserveIds);
const makeSymbolLookup = (entries: [number, string, string][]): Map<string, string> => {
  const map = new Map<string, string>();
  for (const [chainId, symbol, address] of entries) {
    map.set(`${chainId}:${symbol}`, address);
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
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusdt', '1:0xpool:0xusde', '1:0xpool:0xgho']);
    const symbolLookup = makeSymbolLookup([]);
    const result = await detectNetPositionConstraint(opp, '0xusdt', '1:0xpool:0xusdt', reserveIdSet, symbolLookup);
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
    const reserveIdSet = makeReserveIdSet([]);
    const symbolLookup = makeSymbolLookup([]);
    const result = await detectNetPositionConstraint(opp, '0xusdt0', '1:0xpool:0xusdt0', reserveIdSet, symbolLookup, cached);
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
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusdtb']);
    const symbolLookup = makeSymbolLookup([[1, 'USDtb', '0xusdtb']]);
    const mockLlm = async (): Promise<LlmAnalysisResult | null> => ({
      sourceSide: 'supply',
      offsetTokenSymbols: ['USDtb'],
    });
    const result = await detectNetPositionConstraint(opp, '0xusdtb', '1:0xpool:0xusdtb', reserveIdSet, symbolLookup, undefined, mockLlm);
    assert.deepEqual(result, { sourceSide: 'supply', offsetReserveIds: ['1:0xpool:0xusdtb'] });
  });

  it('Layer 3 LLM returns null → falls through to Layer 4 heuristic', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
      description: 'USDT net lending',
      offsetTokenAddresses: [{ address: '0xusdt', reserveId: '1:0xpool:0xusdt' }],
    };
    const mockLlm = async (): Promise<LlmAnalysisResult | null> => null;
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusdt']);
    const symbolLookup = makeSymbolLookup([]);
    const result = await detectNetPositionConstraint(opp, '0xusdt', '1:0xpool:0xusdt', reserveIdSet, symbolLookup, undefined, mockLlm);
    assert.deepEqual(result, { sourceSide: 'supply', offsetReserveIds: ['1:0xpool:0xusdt'] });
  });

  it('returns null when all layers fail (no net keywords, no LLM)', async () => {
    const opp: MerklOpportunityData = {
      supply: [], borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
      description: 'plain supply reward',
    };
    const reserveIdSet = makeReserveIdSet([]);
    const symbolLookup = makeSymbolLookup([]);
    const result = await detectNetPositionConstraint(opp, '0xusdt', '1:0xpool:0xusdt', reserveIdSet, symbolLookup);
    assert.equal(result, null);
  });

  it('LLM offsetTokenSymbols resolved via symbolLookup + reserveIdSet', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'MULTILOG_DUTCH',
      description: 'USDC borrow minus USDC supply',
    };
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusdc']);
    const symbolLookup = makeSymbolLookup([[1, 'USDC', '0xusdc']]);
    const mockLlm = async (): Promise<LlmAnalysisResult | null> => ({
      sourceSide: 'borrow',
      offsetTokenSymbols: ['USDC'],
    });
    const result = await detectNetPositionConstraint(opp, '0xusdc', '1:0xpool:0xusdc', reserveIdSet, symbolLookup, undefined, mockLlm);
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
    const reserveIdSet = makeReserveIdSet(['4326:0xpool:0xusdm']);
    const symbolLookup = makeSymbolLookup([]);
    const result = await detectNetPositionConstraint(opp, '0xusdm', '4326:0xpool:0xusdm', reserveIdSet, symbolLookup);
    assert.deepEqual(result, { sourceSide: 'supply', offsetReserveIds: ['4326:0xpool:0xusdm'] });
  });

  it('Bug3: AAVE_NET_BORROWING includes self token as offset', async () => {
    const opp: MerklOpportunityData = {
      supply: [], borrow: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_NET_BORROWING',
      offsetTokenAddresses: [{ address: '0xgho', reserveId: '1:0xpool:0xgho' }],
    };
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xgho']);
    const symbolLookup = makeSymbolLookup([]);
    const result = await detectNetPositionConstraint(opp, '0xgho', '1:0xpool:0xgho', reserveIdSet, symbolLookup);
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
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusde', '1:0xpool:0xgho']);
    const symbolLookup = makeSymbolLookup([]);
    const result = await detectNetPositionConstraint(opp, '0xusde', '1:0xpool:0xusde', reserveIdSet, symbolLookup);
    assert.deepEqual(result, { sourceSide: 'supply', offsetReserveIds: ['1:0xpool:0xusde', '1:0xpool:0xgho'] });
  });

  it('LLM offsetTokenSymbols not found → falls through to Layer 4 heuristic', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
      description: 'net lending opportunity',
      offsetTokenAddresses: [{ address: '0xusdt', reserveId: '1:0xpool:0xusdt' }],
    };
    const mockLlm = async (): Promise<LlmAnalysisResult | null> => ({
      sourceSide: 'supply',
      offsetTokenSymbols: ['UNKNOWN_TOKEN'],
    });
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusdt']);
    const symbolLookup = makeSymbolLookup([]);
    const result = await detectNetPositionConstraint(opp, '0xusdt', '1:0xpool:0xusdt', reserveIdSet, symbolLookup, undefined, mockLlm);
    assert.deepEqual(result, { sourceSide: 'supply', offsetReserveIds: ['1:0xpool:0xusdt'] });
  });

  it('Bug5: V3 opp resolves offset via pool prefix, not cross-pool', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3EthereumHorizon', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_NET_LENDING',
      offsetTokenAddresses: [{ address: '0xrlusd' }],
    };
    const reserveIdSet = makeReserveIdSet([
      '1:0xhorizonPool:0xrlusd',
      '1:0xmainPool:0xrlusd',
    ]);
    const symbolLookup = makeSymbolLookup([]);
    const oppReserveId = '1:0xhorizonPool:0xsourceToken';
    const result = await detectNetPositionConstraint(opp, '0xsourceToken', oppReserveId, reserveIdSet, symbolLookup);
    assert.deepEqual(result, { sourceSide: 'supply', offsetReserveIds: ['1:0xhorizonPool:0xrlusd'] });
  });

  it('Bug5: V4 opp resolves offset via spoke prefix, across hubs', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV4Ethereum', chainId: 1, protocolVersion: 'v4',
      opportunityType: 'AAVE_NET_LENDING',
      offsetTokenAddresses: [{ address: '0xrlusd' }],
    };
    const reserveIdSet = makeReserveIdSet([
      '1:0xv4spoke:0xrlusd:Core',
      '1:0xv4spoke:0xrlusd:Lido',
      '1:0xmainPool:0xrlusd',
    ]);
    const symbolLookup = makeSymbolLookup([]);
    const oppReserveId = '1:0xv4spoke:0xsourceToken:Core';
    const result = await detectNetPositionConstraint(opp, '0xsourceToken', oppReserveId, reserveIdSet, symbolLookup);
    assert.deepEqual(result, { sourceSide: 'supply', offsetReserveIds: ['1:0xv4spoke:0xrlusd:Core', '1:0xv4spoke:0xrlusd:Lido'] });
  });

  it('Bug5: LLM fallback uses symbolLookup + oppReserveId for pool-scoped resolution', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
    };
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusdc']);
    const symbolLookup = makeSymbolLookup([[1, 'USDC', '0xusdc']]);
    const mockLlm = async (): Promise<LlmAnalysisResult | null> => ({
      sourceSide: 'borrow',
      offsetTokenSymbols: ['USDC'],
    });
    const result = await detectNetPositionConstraint(opp, '0xusdc', '1:0xpool:0xusdc', reserveIdSet, symbolLookup, undefined, mockLlm);
    assert.deepEqual(result, { sourceSide: 'borrow', offsetReserveIds: ['1:0xpool:0xusdc'] });
  });

});

describe('B4: detectNetPositionByHeuristic — Layer 4 keyword detection', () => {

  it('detects "net lending" → supply side', () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
      description: 'USDe net lending',
      offsetTokenAddresses: [{ address: '0xusde', reserveId: '1:0xpool:0xusde' }],
    };
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusde']);
    const symbolLookup = makeSymbolLookup([]);
    const result = detectNetPositionByHeuristic(opp, '1:0xpool:0xusde', reserveIdSet, symbolLookup);
    assert.deepEqual(result, { sourceSide: 'supply', offsetReserveIds: ['1:0xpool:0xusde'] });
  });

  it('detects "excluding borrowers" → supply side', () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
      description: 'GHO supply excluding borrowers',
      offsetTokenAddresses: [{ address: '0xgho', reserveId: '1:0xpool:0xgho' }],
    };
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xgho']);
    const symbolLookup = makeSymbolLookup([]);
    const result = detectNetPositionByHeuristic(opp, '1:0xpool:0xgho', reserveIdSet, symbolLookup);
    assert.deepEqual(result, { sourceSide: 'supply', offsetReserveIds: ['1:0xpool:0xgho'] });
  });

  it('detects "net borrow" → borrow side', () => {
    const opp: MerklOpportunityData = {
      supply: [], borrow: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
      description: 'USDC net borrow position',
      offsetTokenAddresses: [{ address: '0xusdc', reserveId: '1:0xpool:0xusdc' }],
    };
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusdc']);
    const symbolLookup = makeSymbolLookup([]);
    const result = detectNetPositionByHeuristic(opp, '1:0xpool:0xusdc', reserveIdSet, symbolLookup);
    assert.deepEqual(result, { sourceSide: 'borrow', offsetReserveIds: ['1:0xpool:0xusdc'] });
  });

  it('returns null when no net keywords present', () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
      description: 'plain supply reward',
    };
    const reserveIdSet = makeReserveIdSet([]);
    const symbolLookup = makeSymbolLookup([]);
    const result = detectNetPositionByHeuristic(opp, '1:0xpool:0xusdt', reserveIdSet, symbolLookup);
    assert.equal(result, null);
  });

  it('no offsetTokenAddresses → falls back to oppReserveId if in reserveIdSet', () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
      description: 'net USDe supply',
    };
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusde']);
    const symbolLookup = makeSymbolLookup([]);
    const result = detectNetPositionByHeuristic(opp, '1:0xpool:0xusde', reserveIdSet, symbolLookup);
    assert.deepEqual(result, { sourceSide: 'supply', offsetReserveIds: ['1:0xpool:0xusde'] });
  });

});
