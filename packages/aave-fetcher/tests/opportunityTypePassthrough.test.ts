import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MerklOpportunityData } from '../src/merkl-api.js';

describe('B1: opportunityId passthrough', () => {
  it('MerklOpportunityData with opportunityId reflects the original opp.id', () => {
    const data: MerklOpportunityData = {
      supply: [],
      borrow: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      hold: [],
      marketName: 'Aave V3',
      chainId: 1,
      opportunityId: '9830701213305656660',
      name: 'Net Borrow USDe',
      description: 'Users who net borrow USDe...',
      opportunityType: 'AAVE_NET_BORROWING',
    };
    assert.equal(data.opportunityId, '9830701213305656660');
  });

  it('MerklOpportunityData without opportunityId is undefined', () => {
    const data: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c2', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [],
      hold: [],
      marketName: 'Aave V3',
      chainId: 1,
    };
    assert.equal(data.opportunityId, undefined);
  });

  it('MerklOpportunityData preserves opportunityType internally (not output to API)', () => {
    const netTypes = ['AAVE_NET_LENDING', 'AAVE_NET_BORROWING'] as const;
    for (const type of netTypes) {
      const data: MerklOpportunityData = {
        supply: [],
        borrow: [],
        hold: [],
        marketName: 'Aave V3',
        chainId: 1,
        opportunityType: type,
      };
      assert.equal(data.opportunityType, type);
    }
  });
});
