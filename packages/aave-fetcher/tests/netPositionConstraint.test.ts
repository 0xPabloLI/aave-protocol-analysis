import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractNetPositionConstraint } from '../src/merkl-api.js';
import type { MerklOpportunityData } from '../src/merkl-api.js';

const makeReserveIdSet = (reserveIds: string[]): Set<string> => new Set(reserveIds);

describe('netPositionConstraint extraction', () => {

  it('returns constraint for AAVE_NET_LENDING with offset tokens', () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [],
      hold: [],
      marketName: 'AaveV3Ethereum',
      chainId: 1,
      protocolVersion: 'v3',
      opportunityType: 'AAVE_NET_LENDING',
    };
    const offsetTokenAddresses: string[] = [
      '0xusde',
      '0xgho',
    ];
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusdt', '1:0xpool:0xusde', '1:0xpool:0xgho']);
    const result = extractNetPositionConstraint(opp, '0xusdt', '1:0xpool:0xusdt', reserveIdSet, 'reserve', offsetTokenAddresses);
    assert.deepEqual(result, {
      sourceSide: 'supply',
      offsetReserveIds: ['1:0xpool:0xusdt', '1:0xpool:0xusde', '1:0xpool:0xgho'],
    });
  });

  it('returns constraint for AAVE_NET_BORROWING (sourceSide=borrow)', () => {
    const opp: MerklOpportunityData = {
      supply: [],
      borrow: [{ campaignApr: 0.03, campaignId: 'c2', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      hold: [],
      marketName: 'AaveV3Ethereum',
      chainId: 1,
      protocolVersion: 'v3',
      opportunityType: 'AAVE_NET_BORROWING',
    };
    const offsetTokenAddresses: string[] = ['0xusdc'];
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusde', '1:0xpool:0xusdc']);
    const result = extractNetPositionConstraint(opp, '0xusde', '1:0xpool:0xusde', reserveIdSet, 'reserve', offsetTokenAddresses);
    assert.deepEqual(result, {
      sourceSide: 'borrow',
      offsetReserveIds: ['1:0xpool:0xusde', '1:0xpool:0xusdc'],
    });
  });

  it('skips offset tokens not found in reserveIdSet', () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [],
      hold: [],
      marketName: 'AaveV3Ethereum',
      chainId: 1,
      protocolVersion: 'v3',
      opportunityType: 'AAVE_NET_LENDING',
    };
    const offsetTokenAddresses: string[] = [
      '0xusde',
      '0xunknown',
    ];
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusdt', '1:0xpool:0xusde']);
    const result = extractNetPositionConstraint(opp, '0xusdt', '1:0xpool:0xusdt', reserveIdSet, 'reserve', offsetTokenAddresses);
    assert.deepEqual(result, {
      sourceSide: 'supply',
      offsetReserveIds: ['1:0xpool:0xusdt', '1:0xpool:0xusde'],
    });
  });

  it('returns null for non-NET opportunityType', () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [],
      hold: [],
      marketName: 'AaveV3Ethereum',
      chainId: 1,
      protocolVersion: 'v3',
      opportunityType: 'AAVE_SUPPLY',
    };
    const reserveIdSet = makeReserveIdSet([]);
    const result = extractNetPositionConstraint(opp, '0xusdt', '1:0xpool:0xusdt', reserveIdSet);
    assert.equal(result, null);
  });

  it('returns null when opportunityType is undefined', () => {
    const opp: MerklOpportunityData = {
      supply: [],
      borrow: [],
      hold: [],
      marketName: 'AaveV3Ethereum',
      chainId: 1,
      protocolVersion: 'v3',
    };
    const result = extractNetPositionConstraint(opp, '0xusdt', '1:0xpool:0xusdt', new Set());
    assert.equal(result, null);
  });

  it('returns self-only offsetReserveIds when offsetTokenAddresses is empty', () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [],
      hold: [],
      marketName: 'AaveV3Ethereum',
      chainId: 1,
      protocolVersion: 'v3',
      opportunityType: 'AAVE_NET_LENDING',
    };
    const result = extractNetPositionConstraint(opp, '0xusdt', '1:0xpool:0xusdt', new Set(), 'reserve', []);
    assert.deepEqual(result, {
      sourceSide: 'supply',
      offsetReserveIds: ['1:0xpool:0xusdt'],
    });
  });

  it('includes self token in offsetReserveIds for AAVE_NET types (Bug3 fix)', () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [],
      hold: [],
      marketName: 'AaveV3Ethereum',
      chainId: 1,
      protocolVersion: 'v3',
      opportunityType: 'AAVE_NET_LENDING',
    };
    const offsetTokenAddresses: string[] = [
      '0xusdt',
      '0xusde',
    ];
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusdt', '1:0xpool:0xusde']);
    const result = extractNetPositionConstraint(opp, '0xusdt', '1:0xpool:0xusdt', reserveIdSet, 'reserve', offsetTokenAddresses);
    assert.deepEqual(result, {
      sourceSide: 'supply',
      offsetReserveIds: ['1:0xpool:0xusdt', '1:0xpool:0xusde'],
    });
  });

  it('V3 opp resolves offset via pool prefix, not cross-pool', () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [],
      hold: [],
      marketName: 'AaveV3EthereumHorizon',
      chainId: 1,
      protocolVersion: 'v3',
      opportunityType: 'AAVE_NET_LENDING',
    };
    const offsetTokenAddresses: string[] = ['0xrlusd'];
    const reserveIdSet = makeReserveIdSet([
      '1:0xhorizonPool:0xrlusd',
      '1:0xmainPool:0xrlusd',
      '1:0xv4spoke:0xrlusd:Core',
    ]);
    const oppReserveId = '1:0xhorizonPool:0xrlusd';
    const result = extractNetPositionConstraint(opp, '0xrlusd', oppReserveId, reserveIdSet, 'reserve', offsetTokenAddresses);
    assert.deepEqual(result, {
      sourceSide: 'supply',
      offsetReserveIds: ['1:0xhorizonPool:0xrlusd'],
    });
  });

  it('V4 opp with reserve offsetLevel: exact match only (no cross-hub)', () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [],
      hold: [],
      marketName: 'AaveV4Ethereum',
      chainId: 1,
      protocolVersion: 'v4',
      opportunityType: 'AAVE_NET_LENDING',
    };
    const offsetTokenAddresses: string[] = ['0xrlusd'];
    const reserveIdSet = makeReserveIdSet([
      '1:0xv4spoke:0xrlusd:Core',
      '1:0xv4spoke:0xrlusd:Lido',
      '1:0xmainPool:0xrlusd',
    ]);
    const oppReserveId = '1:0xv4spoke:0xsourceToken:Core';
    const result = extractNetPositionConstraint(opp, '0xsourceToken', oppReserveId, reserveIdSet, 'reserve', offsetTokenAddresses);
    assert.deepEqual(result, {
      sourceSide: 'supply',
      offsetReserveIds: ['1:0xv4spoke:0xsourceToken:Core', '1:0xv4spoke:0xrlusd:Core'],
    });
  });

  it('V4 opp with hub-cross-spoke offsetLevel: resolves across spokes within same hub', () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [],
      hold: [],
      marketName: 'AaveV4Ethereum',
      chainId: 1,
      protocolVersion: 'v4',
      opportunityType: 'AAVE_V4_HUB_SUPPLY',
      distributionType: 'AAVE_V4_NET_APR',
    };
    const offsetTokenAddresses: string[] = ['0xrlusd'];
    const reserveIdSet = makeReserveIdSet([
      '1:0xspokeA:0xrlusd:Core',
      '1:0xspokeB:0xrlusd:Core',
      '1:0xspokeA:0xrlusd:Lido',
    ]);
    const oppReserveId = '1:0xspokeA:0xsourceToken:Core';
    const result = extractNetPositionConstraint(opp, '0xsourceToken', oppReserveId, reserveIdSet, 'hub-cross-spoke', offsetTokenAddresses);
    assert.deepEqual(result, {
      sourceSide: 'supply',
      offsetReserveIds: ['1:0xspokeA:0xsourceToken:Core', '1:0xspokeA:0xrlusd:Core', '1:0xspokeB:0xrlusd:Core'],
    });
  });
});
