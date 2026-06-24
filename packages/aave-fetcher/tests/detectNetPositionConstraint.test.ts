import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectNetPositionConstraint, composedNetPositionConstraint } from '../src/merkl-api.js';
import type { MerklOpportunityData } from '../src/merkl-api.js';
import type { NetPositionConstraint } from '@internal/aave-shared-contracts';
import type { LlmOutcome } from '../src/merklLlmClient.js';

const makeReserveIdSet = (reserveIds: string[]): Set<string> => new Set(reserveIds);
const makeSymbolLookup = (entries: [number, string, string][]): Map<string, string> => {
  const map = new Map<string, string>();
  for (const [chainId, symbol, address] of entries) {
    map.set(`${chainId}:${symbol}`, address);
  }
  return map;
};

describe('B4: detectNetPositionConstraint — four-layer detection', () => {

  it('L0 (type match) takes priority over L1 (looping) — AAVE_NET_LENDING with "looping" in name still returns constraint', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_NET_LENDING',
      name: 'Net Lending USDT (looping)',
      description: '',
      offsetTokenAddresses: ['0xborrowtoken'],
    };
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusdt', '1:0xpool:0xborrowtoken']);
    const symbolLookup = makeSymbolLookup([]);
    const result = await detectNetPositionConstraint(opp, '0xusdt', '1:0xpool:0xusdt', reserveIdSet, symbolLookup);
    assert.notEqual(result, null);
    assert.equal(result!.sourceSide, 'supply');
  });

  it('L1 excludes looping — name contains "looping required" returns null (non-NET type)', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'MULTILOG_DUTCH',
      name: 'Lend USDe on Aave (looping required)',
      description: 'Ethena Liquid Leverage program. Users must also borrow USDT0.',
    };
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusde']);
    const symbolLookup = makeSymbolLookup([]);
    const result = await detectNetPositionConstraint(opp, '0xusde', '1:0xpool:0xusde', reserveIdSet, symbolLookup);
    assert.equal(result, null);
  });

  it('L1 excludes looping — description contains "looping" returns null (non-NET type)', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
      name: 'Lend sUSDe and USDe on Aave',
      description: 'This is a looping strategy where users supply and borrow the same asset.',
    };
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusde']);
    const symbolLookup = makeSymbolLookup([]);
    const result = await detectNetPositionConstraint(opp, '0xusde', '1:0xpool:0xusde', reserveIdSet, symbolLookup);
    assert.equal(result, null);
  });

  it('L0 returns constraint for AAVE_NET_LENDING', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Plasma', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_NET_LENDING',
      offsetTokenAddresses: [
        '0xusde',
        '0xgho',
      ],
    };
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusdt', '1:0xpool:0xusde', '1:0xpool:0xgho']);
    const symbolLookup = makeSymbolLookup([]);
    const result = await detectNetPositionConstraint(opp, '0xusdt', '1:0xpool:0xusdt', reserveIdSet, symbolLookup);
    assert.deepEqual(result, { sourceSide: 'supply', offsetReserveIds: ['1:0xpool:0xusdt', '1:0xpool:0xusde', '1:0xpool:0xgho'] });
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
    const mockLlm = async (): Promise<LlmOutcome> => ({
      tag: 'result',
      value: { sourceSide: 'supply', offsetTokenSymbols: ['USDtb'] },
    });
    const result = await detectNetPositionConstraint(opp, '0xusdtb', '1:0xpool:0xusdtb', reserveIdSet, symbolLookup, undefined, mockLlm);
    assert.deepEqual(result, { sourceSide: 'supply', offsetReserveIds: ['1:0xpool:0xusdtb'] });
  });

  it('Layer 3 LLM returns null → returns null (no heuristic fallback)', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
      description: 'USDT net lending',
      offsetTokenAddresses: ['0xusdt'],
    };
    const mockLlm = async (): Promise<LlmOutcome> => ({ tag: 'result', value: null });
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusdt']);
    const symbolLookup = makeSymbolLookup([]);
    const result = await detectNetPositionConstraint(opp, '0xusdt', '1:0xpool:0xusdt', reserveIdSet, symbolLookup, undefined, mockLlm);
    assert.equal(result, null);
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
    const mockLlm = async (): Promise<LlmOutcome> => ({
      tag: 'result',
      value: { sourceSide: 'borrow', offsetTokenSymbols: ['USDC'] },
    });
    const result = await detectNetPositionConstraint(opp, '0xusdc', '1:0xpool:0xusdc', reserveIdSet, symbolLookup, undefined, mockLlm);
    assert.deepEqual(result, { sourceSide: 'borrow', offsetReserveIds: ['1:0xpool:0xusdc'] });
  });

  it('L0 distributionType match — AAVE_V4_NET_APR recognized as net position', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV4Ethereum', chainId: 1, protocolVersion: 'v4',
      opportunityType: 'AAVE_V4_HUB_SUPPLY',
      distributionType: 'AAVE_V4_NET_APR',
      name: 'Supply USDG V4 Hub',
    };
    const reserveIdSet = makeReserveIdSet(['1:0xspoke:0xusdg:Core']);
    const symbolLookup = makeSymbolLookup([]);
    const result = await detectNetPositionConstraint(opp, '0xusdg', '1:0xspoke:0xusdg:Core', reserveIdSet, symbolLookup);
    assert.notEqual(result, null);
    assert.equal(result!.sourceSide, 'supply');
    assert.ok(result!.offsetReserveIds.includes('1:0xspoke:0xusdg:Core'), 'self token should be in offsetReserveIds');
  });

  it('L0 distributionType match — AAVE_NET_APR recognized as net position (borrow side)', async () => {
    const opp: MerklOpportunityData = {
      supply: [], borrow: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
      distributionType: 'AAVE_NET_APR',
      name: 'Borrow GHO Net APR',
    };
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xgho']);
    const symbolLookup = makeSymbolLookup([]);
    const result = await detectNetPositionConstraint(opp, '0xgho', '1:0xpool:0xgho', reserveIdSet, symbolLookup);
    assert.notEqual(result, null);
    assert.equal(result!.sourceSide, 'borrow');
    assert.ok(result!.offsetReserveIds.includes('1:0xpool:0xgho'), 'self token should be in offsetReserveIds');
  });

  it('L0 distributionType match — non-net distributionType ignored', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
      distributionType: 'DUTCH_AUCTION',
      name: 'Supply USDC',
    };
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusdc']);
    const symbolLookup = makeSymbolLookup([]);
    const result = await detectNetPositionConstraint(opp, '0xusdc', '1:0xpool:0xusdc', reserveIdSet, symbolLookup);
    assert.equal(result, null);
  });

  it('L0 opportunityType match takes priority over distributionType', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_NET_BORROWING',
      distributionType: 'AAVE_V4_NET_APR',
      offsetTokenAddresses: ['0xusde'],
    };
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusde']);
    const symbolLookup = makeSymbolLookup([]);
    const result = await detectNetPositionConstraint(opp, '0xusdt', '1:0xpool:0xusdt', reserveIdSet, symbolLookup);
    assert.notEqual(result, null);
    assert.equal(result!.sourceSide, 'borrow');
  });

  it('L0 AAVE_NET_LENDING self-token always included in offsetReserveIds', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3MegaETH', chainId: 4326, protocolVersion: 'v3',
      opportunityType: 'AAVE_NET_LENDING',
      offsetTokenAddresses: ['0xusdm'],
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
      offsetTokenAddresses: ['0xgho'],
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
        '0xusde',
        '0xgho',
      ],
    };
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusde', '1:0xpool:0xgho']);
    const symbolLookup = makeSymbolLookup([]);
    const result = await detectNetPositionConstraint(opp, '0xusde', '1:0xpool:0xusde', reserveIdSet, symbolLookup);
    assert.deepEqual(result, { sourceSide: 'supply', offsetReserveIds: ['1:0xpool:0xusde', '1:0xpool:0xgho'] });
  });

  it('LLM offsetTokenSymbols not found → returns null (no heuristic fallback)', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
      description: 'net lending opportunity',
      offsetTokenAddresses: ['0xusdt'],
    };
    const mockLlm = async (): Promise<LlmOutcome> => ({
      tag: 'result',
      value: { sourceSide: 'supply', offsetTokenSymbols: ['UNKNOWN_TOKEN'] },
    });
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusdt']);
    const symbolLookup = makeSymbolLookup([]);
    const result = await detectNetPositionConstraint(opp, '0xusdt', '1:0xpool:0xusdt', reserveIdSet, symbolLookup, undefined, mockLlm);
    assert.equal(result, null);
  });

  it('Bug5: V3 opp resolves offset via pool prefix, not cross-pool', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3EthereumHorizon', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_NET_LENDING',
      offsetTokenAddresses: ['0xrlusd'],
    };
    const reserveIdSet = makeReserveIdSet([
      '1:0xhorizonPool:0xrlusd',
      '1:0xmainPool:0xrlusd',
    ]);
    const symbolLookup = makeSymbolLookup([]);
    const oppReserveId = '1:0xhorizonPool:0xsourceToken';
    const result = await detectNetPositionConstraint(opp, '0xsourceToken', oppReserveId, reserveIdSet, symbolLookup);
    assert.deepEqual(result, { sourceSide: 'supply', offsetReserveIds: ['1:0xhorizonPool:0xsourceToken', '1:0xhorizonPool:0xrlusd'] });
  });

  it('Bug5: V4 opp resolves offset via spoke prefix, across hubs', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV4Ethereum', chainId: 1, protocolVersion: 'v4',
      opportunityType: 'AAVE_NET_LENDING',
      offsetTokenAddresses: ['0xrlusd'],
    };
    const reserveIdSet = makeReserveIdSet([
      '1:0xv4spoke:0xrlusd:Core',
      '1:0xv4spoke:0xrlusd:Lido',
      '1:0xmainPool:0xrlusd',
    ]);
    const symbolLookup = makeSymbolLookup([]);
    const oppReserveId = '1:0xv4spoke:0xsourceToken:Core';
    const result = await detectNetPositionConstraint(opp, '0xsourceToken', oppReserveId, reserveIdSet, symbolLookup, undefined, undefined, 'spoke');
    assert.deepEqual(result, { sourceSide: 'supply', offsetReserveIds: ['1:0xv4spoke:0xsourceToken:Core', '1:0xv4spoke:0xrlusd:Core', '1:0xv4spoke:0xrlusd:Lido'] });
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
    const mockLlm = async (): Promise<LlmOutcome> => ({
      tag: 'result',
      value: { sourceSide: 'borrow', offsetTokenSymbols: ['USDC'] },
    });
    const result = await detectNetPositionConstraint(opp, '0xusdc', '1:0xpool:0xusdc', reserveIdSet, symbolLookup, undefined, mockLlm);
    assert.deepEqual(result, { sourceSide: 'borrow', offsetReserveIds: ['1:0xpool:0xusdc'] });
  });

  it('Layer 1+2+3 all miss → returns null (no heuristic fallback)', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
      description: 'plain supply reward without net keywords',
    };
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusdc']);
    const symbolLookup = makeSymbolLookup([]);
    const result = await detectNetPositionConstraint(opp, '0xusdc', '1:0xpool:0xusdc', reserveIdSet, symbolLookup);
    assert.equal(result, null);
  });

  it('LLM symbol not in symbolLookup → returns null (no heuristic fallback)', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
      description: 'supply reward',
    };
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusdc']);
    const symbolLookup = makeSymbolLookup([]);
    const mockLlm = async (): Promise<LlmOutcome> => ({
      tag: 'result',
      value: { sourceSide: 'supply', offsetTokenSymbols: ['UNKNOWN_TOKEN'] },
    });
    const result = await detectNetPositionConstraint(opp, '0xusdc', '1:0xpool:0xusdc', reserveIdSet, symbolLookup, undefined, mockLlm);
    assert.equal(result, null);
  });

  it('LLM resolves but offsetReserveIds empty → returns null (no heuristic fallback)', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
      description: 'supply reward',
    };
    const reserveIdSet = makeReserveIdSet([]);
    const symbolLookup = makeSymbolLookup([[1, 'USDC', '0xusdc']]);
    const mockLlm = async (): Promise<LlmOutcome> => ({
      tag: 'result',
      value: { sourceSide: 'borrow', offsetTokenSymbols: ['USDC'] },
    });
    const result = await detectNetPositionConstraint(opp, '0xusdc', '1:0xpool:0xusdc', reserveIdSet, symbolLookup, undefined, mockLlm);
    assert.equal(result, null);
  });

  it('Layer 4 regex fallback — net supply keyword when LLM unavailable', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
      name: 'Net Supply USDC',
    };
    const reserveIdSet = makeReserveIdSet([]);
    const symbolLookup = makeSymbolLookup([]);
    const mockLlm = async (): Promise<LlmOutcome> => ({ tag: 'unavailable' });
    const result = await detectNetPositionConstraint(opp, '0xusdc', '1:0xpool:0xusdc', reserveIdSet, symbolLookup, undefined, mockLlm);
    assert.deepEqual(result, { sourceSide: 'supply', offsetReserveIds: ['1:0xpool:0xusdc'] });
  });

  it('Layer 4 regex fallback — net borrow keyword when LLM unavailable', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
      description: 'Net borrow position incentive',
    };
    const reserveIdSet = makeReserveIdSet([]);
    const symbolLookup = makeSymbolLookup([]);
    const mockLlm = async (): Promise<LlmOutcome> => ({ tag: 'unavailable' });
    const result = await detectNetPositionConstraint(opp, '0xusdc', '1:0xpool:0xusdc', reserveIdSet, symbolLookup, undefined, mockLlm);
    assert.deepEqual(result, { sourceSide: 'borrow', offsetReserveIds: ['1:0xpool:0xusdc'] });
  });

  it('Layer 4 regex fallback NOT triggered when LLM returns result (even null)', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
      name: 'Net Supply USDC',
    };
    const reserveIdSet = makeReserveIdSet([]);
    const symbolLookup = makeSymbolLookup([]);
    const mockLlm = async (): Promise<LlmOutcome> => ({ tag: 'result', value: null });
    const result = await detectNetPositionConstraint(opp, '0xusdc', '1:0xpool:0xusdc', reserveIdSet, symbolLookup, undefined, mockLlm);
    assert.equal(result, null);
  });

  it('Layer 4 regex fallback — inferred borrow side from opp.borrow array + both-side text', async () => {
    const opp: MerklOpportunityData = {
      supply: [], borrow: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'MULTILOG_DUTCH',
      name: 'Borrow USDC, supply USDT offset',
    };
    const reserveIdSet = makeReserveIdSet([]);
    const symbolLookup = makeSymbolLookup([]);
    const mockLlm = async (): Promise<LlmOutcome> => ({ tag: 'unavailable' });
    const result = await detectNetPositionConstraint(opp, '0xusdc', '1:0xpool:0xusdc', reserveIdSet, symbolLookup, undefined, mockLlm);
    assert.deepEqual(result, { sourceSide: 'borrow', offsetReserveIds: ['1:0xpool:0xusdc'] });
  });

  it('Layer 4 regex fallback — inferred supply side from opp.supply array + both-side text', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }], borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
      name: 'Supply USDC minus borrow USDC',
    };
    const reserveIdSet = makeReserveIdSet([]);
    const symbolLookup = makeSymbolLookup([]);
    const mockLlm = async (): Promise<LlmOutcome> => ({ tag: 'unavailable' });
    const result = await detectNetPositionConstraint(opp, '0xusdc', '1:0xpool:0xusdc', reserveIdSet, symbolLookup, undefined, mockLlm);
    assert.deepEqual(result, { sourceSide: 'supply', offsetReserveIds: ['1:0xpool:0xusdc'] });
  });

  it('Layer 4 regex fallback — single-side keyword only is not net position', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }], borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
      name: 'Lend USDC',
    };
    const reserveIdSet = makeReserveIdSet([]);
    const symbolLookup = makeSymbolLookup([]);
    const mockLlm = async (): Promise<LlmOutcome> => ({ tag: 'unavailable' });
    const result = await detectNetPositionConstraint(opp, '0xusdc', '1:0xpool:0xusdc', reserveIdSet, symbolLookup, undefined, mockLlm);
    assert.equal(result, null);
  });

  it('Layer 4 regex fallback — no net keyword → returns null', async () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
      name: 'Supply USDC',
    };
    const reserveIdSet = makeReserveIdSet([]);
    const symbolLookup = makeSymbolLookup([]);
    const mockLlm = async (): Promise<LlmOutcome> => ({ tag: 'unavailable' });
    const result = await detectNetPositionConstraint(opp, '0xusdc', '1:0xpool:0xusdc', reserveIdSet, symbolLookup, undefined, mockLlm);
    assert.equal(result, null);
  });

});

describe('L0.5: composedNetPositionConstraint — 1-2 compute detection', () => {

  it('1-2 BORROW → returns net borrow with self reserveId', async () => {
    const opp: MerklOpportunityData = {
      supply: [], borrow: [{ campaignApr: 0.02, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }], hold: [],
      marketName: 'AaveV3Plasma', chainId: 9745, protocolVersion: 'v3',
      opportunityType: 'MULTILOG_DUTCH',
      composedCampaignsCompute: '1-2',
      composedSubCampaigns: [
        { underlyingToken: '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb', campaignType: 61, composedType: 'MAIN' },
        { underlyingToken: '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb', campaignType: 60, composedType: 'DEFAULT' },
      ],
    };
    const reserveIdSet = makeReserveIdSet(['9745:0xpool:0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb']);
    const result = composedNetPositionConstraint(opp, '9745:0xpool:0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb', reserveIdSet);
    assert.deepEqual(result, { sourceSide: 'borrow', offsetReserveIds: ['9745:0xpool:0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb'] });
  });

  it('1-2 LEND → returns net supply with self reserveId', () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }], borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'MULTILOG_DUTCH',
      composedCampaignsCompute: '1-2',
      composedSubCampaigns: [
        { underlyingToken: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', campaignType: 60, composedType: 'MAIN' },
        { underlyingToken: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', campaignType: 61, composedType: 'DEFAULT' },
      ],
    };
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48']);
    const result = composedNetPositionConstraint(opp, '1:0xpool:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', reserveIdSet);
    assert.deepEqual(result, { sourceSide: 'supply', offsetReserveIds: ['1:0xpool:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'] });
  });

  it('min(1,2) → returns null (not net position)', () => {
    const opp: MerklOpportunityData = {
      supply: [], borrow: [{ campaignApr: 0.01, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }], hold: [],
      marketName: 'AaveV3Base', chainId: 8453, protocolVersion: 'v3',
      opportunityType: 'MULTILOG_DUTCH',
      composedCampaignsCompute: 'min(1,2)',
    };
    const reserveIdSet = makeReserveIdSet([]);
    const result = composedNetPositionConstraint(opp, '8453:0xpool:0xweth', reserveIdSet);
    assert.equal(result, null);
  });

  it('1+2+3 → returns null', () => {
    const opp: MerklOpportunityData = {
      supply: [], borrow: [], hold: [{ campaignApr: 0.01, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      marketName: 'Unknown', chainId: 1, protocolVersion: 'v3',
      composedCampaignsCompute: '1+2+3',
    };
    const reserveIdSet = makeReserveIdSet([]);
    const result = composedNetPositionConstraint(opp, '1:0xpool:0xtoken', reserveIdSet);
    assert.equal(result, null);
  });

  it('no composedCampaignsCompute → returns null', () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }], borrow: [], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
    };
    const reserveIdSet = makeReserveIdSet([]);
    const result = composedNetPositionConstraint(opp, '1:0xpool:0xusdc', reserveIdSet);
    assert.equal(result, null);
  });

  it('1-2 integration: L0.5 captures before L1 looping check', async () => {
    const opp: MerklOpportunityData = {
      supply: [], borrow: [{ campaignApr: 0.02, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }], hold: [],
      marketName: 'AaveV3Plasma', chainId: 9745, protocolVersion: 'v3',
      opportunityType: 'MULTILOG_DUTCH',
      name: 'Borrow USDT0 (looping required)',
      composedCampaignsCompute: '1-2',
      composedSubCampaigns: [
        { underlyingToken: '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb', campaignType: 61 },
        { underlyingToken: '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb', campaignType: 60 },
      ],
    };
    const reserveIdSet = makeReserveIdSet(['9745:0xpool:0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb']);
    const symbolLookup = makeSymbolLookup([]);
    const result = await detectNetPositionConstraint(opp, '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb', '9745:0xpool:0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb', reserveIdSet, symbolLookup);
    assert.deepEqual(result, { sourceSide: 'borrow', offsetReserveIds: ['9745:0xpool:0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb'] });
  });

  it('1-2 with no sub-campaign underlyingToken → still returns self reserveId', () => {
    const opp: MerklOpportunityData = {
      supply: [], borrow: [{ campaignApr: 0.02, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }], hold: [],
      marketName: 'AaveV3Ethereum', chainId: 1, protocolVersion: 'v3',
      opportunityType: 'MULTILOG_DUTCH',
      composedCampaignsCompute: '1-2',
      composedSubCampaigns: [],
    };
    const reserveIdSet = makeReserveIdSet([]);
    const result = composedNetPositionConstraint(opp, '1:0xpool:0xusdc', reserveIdSet);
    assert.deepEqual(result, { sourceSide: 'borrow', offsetReserveIds: ['1:0xpool:0xusdc'] });
  });

});

