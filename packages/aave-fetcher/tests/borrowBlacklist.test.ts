import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MerklOpportunityData } from '../src/merkl-api.js';

describe('AAV-924: borrowBlacklist field on MerklOpportunityData', () => {
  it('borrowBlacklist is true when BORROW_BL detected', () => {
    const data: MerklOpportunityData = {
      supply: [{ campaignApr: 0.05, campaignId: 'c1', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [],
      hold: [],
      marketName: 'Aave V3 Ethereum',
      chainId: 1,
      protocolVersion: 'v3',
      opportunityId: '9830701213305656660',
      opportunityType: 'AAVE_SUPPLY',
      borrowBlacklist: true,
    };
    assert.equal(data.borrowBlacklist, true);
  });

  it('borrowBlacklist is undefined when not set', () => {
    const data: MerklOpportunityData = {
      supply: [{ campaignApr: 0.03, campaignId: 'c2', campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      borrow: [],
      hold: [],
      marketName: 'Aave V3 Ethereum',
      chainId: 1,
      protocolVersion: 'v3',
    };
    assert.equal(data.borrowBlacklist, undefined);
  });
});
