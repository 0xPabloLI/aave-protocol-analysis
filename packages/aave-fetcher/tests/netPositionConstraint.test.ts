import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractNetPositionConstraint } from '../src/merkl-api.js';
import type { MerklOpportunityData } from '../src/merkl-api.js';
import type { RuntimeReserveData } from '@internal/aave-shared-contracts';

describe('B2: Layer 1 — netPositionConstraint extraction', () => {
  const makeReserveLookup = (reserves: Partial<RuntimeReserveData>[]): Map<string, Partial<RuntimeReserveData>> => {
    const map = new Map<string, Partial<RuntimeReserveData>>();
    for (const r of reserves) {
      const key = `${r.chainId}:${(r.tokenAddress ?? '').toLowerCase()}`;
      map.set(key, r);
    }
    return map;
  };

  it('returns constraint for AAVE_NET_LENDING with offset tokens', () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [],
      hold: [],
      marketName: 'AaveV3Ethereum',
      chainId: 1,
      opportunityType: 'AAVE_NET_LENDING',
      offsetTokenAddresses: [
        { address: '0xusde', reserveId: '1:0xpool:0xusde' },
        { address: '0xgho', reserveId: '1:0xpool:0xgho' },
      ],
    };
    const lookup = makeReserveLookup([
      { reserveId: '1:0xpool:0xusdt', chainId: 1, tokenAddress: '0xusdt' },
    ]);
    const result = extractNetPositionConstraint(opp, '0xusdt', lookup);
    assert.deepEqual(result, {
      sourceSide: 'supply',
      offsetReserveIds: ['1:0xpool:0xusde', '1:0xpool:0xgho'],
    });
  });

  it('returns constraint for AAVE_NET_BORROWING (sourceSide=borrow)', () => {
    const opp: MerklOpportunityData = {
      supply: [],
      borrow: [{ campaignApr: 0.03, campaignId: 'c2', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      hold: [],
      marketName: 'AaveV3Ethereum',
      chainId: 1,
      opportunityType: 'AAVE_NET_BORROWING',
      offsetTokenAddresses: [{ address: '0xusdc', reserveId: '1:0xpool:0xusdc' }],
    };
    const lookup = makeReserveLookup([
      { reserveId: '1:0xpool:0xusde', chainId: 1, tokenAddress: '0xusde' },
    ]);
    const result = extractNetPositionConstraint(opp, '0xusde', lookup);
    assert.deepEqual(result, {
      sourceSide: 'borrow',
      offsetReserveIds: ['1:0xpool:0xusdc'],
    });
  });

  it('skips offset tokens not found in reserve lookup', () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [],
      hold: [],
      marketName: 'AaveV3Ethereum',
      chainId: 1,
      opportunityType: 'AAVE_NET_LENDING',
      offsetTokenAddresses: [
        { address: '0xusde', reserveId: '1:0xpool:0xusde' },
        { address: '0xunknown' },
      ],
    };
    const lookup = makeReserveLookup([
      { reserveId: '1:0xpool:0xusdt', chainId: 1, tokenAddress: '0xusdt' },
      { reserveId: '1:0xpool:0xusde', chainId: 1, tokenAddress: '0xusde' },
    ]);
    const result = extractNetPositionConstraint(opp, '0xusdt', lookup);
    assert.deepEqual(result, {
      sourceSide: 'supply',
      offsetReserveIds: ['1:0xpool:0xusde'],
    });
  });

  it('returns null for non-NET opportunityType', () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [],
      hold: [],
      marketName: 'AaveV3Ethereum',
      chainId: 1,
      opportunityType: 'AAVE_SUPPLY',
    };
    const lookup = makeReserveLookup([]);
    const result = extractNetPositionConstraint(opp, '0xusdt', lookup);
    assert.equal(result, null);
  });

  it('returns null when opportunityType is undefined', () => {
    const opp: MerklOpportunityData = {
      supply: [],
      borrow: [],
      hold: [],
      marketName: 'AaveV3Ethereum',
      chainId: 1,
    };
    const result = extractNetPositionConstraint(opp, '0xusdt', new Map());
    assert.equal(result, null);
  });

  it('returns null when offsetTokenAddresses is empty (all tokens excluded or missing)', () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [],
      hold: [],
      marketName: 'AaveV3Ethereum',
      chainId: 1,
      opportunityType: 'AAVE_NET_LENDING',
      offsetTokenAddresses: [],
    };
    const result = extractNetPositionConstraint(opp, '0xusdt', new Map());
    assert.equal(result, null);
  });

  it('includes self token in offsetReserveIds for AAVE_NET types (Bug3 fix)', () => {
    const opp: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [],
      hold: [],
      marketName: 'AaveV3Ethereum',
      chainId: 1,
      opportunityType: 'AAVE_NET_LENDING',
      offsetTokenAddresses: [
        { address: '0xusdt', reserveId: '1:0xpool:0xusdt' },
        { address: '0xusde', reserveId: '1:0xpool:0xusde' },
      ],
    };
    const lookup = makeReserveLookup([]);
    const result = extractNetPositionConstraint(opp, '0xusdt', lookup);
    assert.deepEqual(result, {
      sourceSide: 'supply',
      offsetReserveIds: ['1:0xpool:0xusdt', '1:0xpool:0xusde'],
    });
  });
});
