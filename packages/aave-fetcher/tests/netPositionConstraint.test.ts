import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractNetPositionConstraint } from '../src/merkl-api.js';
import type { MerklOpportunityData } from '../src/merkl-api.js';

const makeReserveIdSet = (reserveIds: string[]): Set<string> => new Set(reserveIds);

describe('B2: Layer 1 — netPositionConstraint extraction', () => {

  it('returns constraint for AAVE_NET_LENDING with offset tokens', () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [],
      hold: [],
      marketName: 'AaveV3Ethereum',
      chainId: 1,
      protocolVersion: 'v3',
      opportunityType: 'AAVE_NET_LENDING',
      offsetTokenAddresses: [
        { address: '0xusde', reserveId: '1:0xpool:0xusde' },
        { address: '0xgho', reserveId: '1:0xpool:0xgho' },
      ],
    };
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusdt', '1:0xpool:0xusde', '1:0xpool:0xgho']);
    const result = extractNetPositionConstraint(opp, '0xusdt', '1:0xpool:0xusdt', reserveIdSet);
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
      offsetTokenAddresses: [{ address: '0xusdc', reserveId: '1:0xpool:0xusdc' }],
    };
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusde', '1:0xpool:0xusdc']);
    const result = extractNetPositionConstraint(opp, '0xusde', '1:0xpool:0xusde', reserveIdSet);
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
      offsetTokenAddresses: [
        { address: '0xusde', reserveId: '1:0xpool:0xusde' },
        { address: '0xunknown' },
      ],
    };
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusdt', '1:0xpool:0xusde']);
    const result = extractNetPositionConstraint(opp, '0xusdt', '1:0xpool:0xusdt', reserveIdSet);
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
      offsetTokenAddresses: [],
    };
    const result = extractNetPositionConstraint(opp, '0xusdt', '1:0xpool:0xusdt', new Set());
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
      offsetTokenAddresses: [
        { address: '0xusdt', reserveId: '1:0xpool:0xusdt' },
        { address: '0xusde', reserveId: '1:0xpool:0xusde' },
      ],
    };
    const reserveIdSet = makeReserveIdSet(['1:0xpool:0xusdt', '1:0xpool:0xusde']);
    const result = extractNetPositionConstraint(opp, '0xusdt', '1:0xpool:0xusdt', reserveIdSet);
    assert.deepEqual(result, {
      sourceSide: 'supply',
      offsetReserveIds: ['1:0xpool:0xusdt', '1:0xpool:0xusde'],
    });
  });

  it('Bug5: V3 opp resolves offset via pool prefix, not cross-pool', () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [],
      hold: [],
      marketName: 'AaveV3EthereumHorizon',
      chainId: 1,
      protocolVersion: 'v3',
      opportunityType: 'AAVE_NET_LENDING',
      offsetTokenAddresses: [{ address: '0xrlusd' }],
    };
    const reserveIdSet = makeReserveIdSet([
      '1:0xhorizonPool:0xrlusd',
      '1:0xmainPool:0xrlusd',
      '1:0xv4spoke:0xrlusd:Core',
    ]);
    const oppReserveId = '1:0xhorizonPool:0xrlusd';
    const result = extractNetPositionConstraint(opp, '0xrlusd', oppReserveId, reserveIdSet);
    assert.deepEqual(result, {
      sourceSide: 'supply',
      offsetReserveIds: ['1:0xhorizonPool:0xrlusd'],
    });
  });

  it('Bug5: V4 opp resolves offset via spoke prefix, across hubs', () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [],
      hold: [],
      marketName: 'AaveV4Ethereum',
      chainId: 1,
      protocolVersion: 'v4',
      opportunityType: 'AAVE_NET_LENDING',
      offsetTokenAddresses: [{ address: '0xrlusd' }],
    };
    const reserveIdSet = makeReserveIdSet([
      '1:0xv4spoke:0xrlusd:Core',
      '1:0xv4spoke:0xrlusd:Lido',
      '1:0xmainPool:0xrlusd',
    ]);
    const oppReserveId = '1:0xv4spoke:0xsourceToken:Core';
    const result = extractNetPositionConstraint(opp, '0xsourceToken', oppReserveId, reserveIdSet, 'spoke');
    assert.deepEqual(result, {
      sourceSide: 'supply',
      offsetReserveIds: ['1:0xv4spoke:0xsourceToken:Core', '1:0xv4spoke:0xrlusd:Core', '1:0xv4spoke:0xrlusd:Lido'],
    });
  });
});
