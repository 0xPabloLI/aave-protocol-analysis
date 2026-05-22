import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MerklOpportunityData } from '../src/merkl-api.js';

describe('B1: opportunityType passthrough', () => {
  it('MerklOpportunityData with opportunityType reflects the original opportunity.type', () => {
    const data: MerklOpportunityData = {
      supply: [],
      borrow: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      hold: [],
      marketName: 'Aave V3',
      chainId: 1,
      opportunityLink: 'https://merkl.xyz/opp/1',
      name: 'Net Borrow USDe',
      description: 'Users who net borrow USDe...',
      opportunityType: 'AAVE_NET_BORROWING',
    };
    assert.equal(data.opportunityType, 'AAVE_NET_BORROWING');
  });

  it('MerklOpportunityData without opportunityType is undefined', () => {
    const data: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c2', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [],
      hold: [],
      marketName: 'Aave V3',
      chainId: 1,
    };
    assert.equal(data.opportunityType, undefined);
  });

  it('MerklOpportunityData preserves all NET type values', () => {
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
