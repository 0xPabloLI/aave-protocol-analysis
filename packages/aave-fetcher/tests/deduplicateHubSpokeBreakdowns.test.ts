import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deduplicateHubSpokeBreakdowns } from '../src/merkl-api.js';
import type { MerklOpportunityGroup, MerklCampaignBreakdown } from '@internal/aave-shared-contracts';

function mkBreakdown(campaignId: string, apr: number, parentCampaignId?: string): MerklCampaignBreakdown {
  return {
    campaignApr: apr,
    campaignStartedAt: '2026-01-01T00:00:00.000Z',
    campaignEndedAt: '2026-12-31T00:00:00.000Z',
    campaignId,
    ...(parentCampaignId ? { parentCampaignId } : {}),
  };
}

function mkGroup(opportunityType: string, breakdowns: MerklCampaignBreakdown[], opportunityId = '1234567890'): MerklOpportunityGroup {
  return {
    link: opportunityId ? `https://app.merkl.xyz/opportunities/${opportunityId}` : '',
    opportunityId,
    opportunityType,
    breakdowns,
  };
}

describe('deduplicateHubSpokeBreakdowns — V4 Hub/Spoke breakdown-level dedup', () => {

  describe('scenario 1: parent-child overlap → keep Spoke, remove parent Hub', () => {
    it('removes Hub breakdown whose campaignId is a Spoke parentCampaignId', () => {
      const HUB_ID = 'hub-100';
      const SPOKE_ID = 'spoke-200';
      const groups = [
        mkGroup('AAVE_V4_HUB_SUPPLY', [mkBreakdown(HUB_ID, 0.0677)]),
        mkGroup('AAVE_V4_SPOKE_SUPPLY', [mkBreakdown(SPOKE_ID, 0.0648, HUB_ID)]),
      ];
      const result = deduplicateHubSpokeBreakdowns(groups);
      // Spoke group kept
      assert.equal(result.length, 1);
      assert.equal(result[0].opportunityType, 'AAVE_V4_SPOKE_SUPPLY');
      assert.equal(result[0].breakdowns[0].campaignId, SPOKE_ID);
    });
  });

  describe('scenario 2: non-parent same reserve → both kept', () => {
    it('keeps Hub when Spoke parentCampaignId does not match any Hub campaignId', () => {
      const HUB_ID = 'hub-100';
      const OTHER_HUB_ID = 'hub-999';
      const SPOKE_ID = 'spoke-200';
      const groups = [
        mkGroup('AAVE_V4_HUB_SUPPLY', [mkBreakdown(HUB_ID, 0.0677)]),
        mkGroup('AAVE_V4_SPOKE_SUPPLY', [mkBreakdown(SPOKE_ID, 0.0648, OTHER_HUB_ID)]),
      ];
      const result = deduplicateHubSpokeBreakdowns(groups);
      // Both kept — Spoke's parent is hub-999, not hub-100
      assert.equal(result.length, 2);
      assert.ok(result.some(g => g.opportunityType === 'AAVE_V4_HUB_SUPPLY'));
      assert.ok(result.some(g => g.opportunityType === 'AAVE_V4_SPOKE_SUPPLY'));
    });
  });

  describe('scenario 3: only Hub → keep Hub', () => {
    it('keeps Hub group when no Spoke group exists', () => {
      const groups = [
        mkGroup('AAVE_V4_HUB_SUPPLY', [mkBreakdown('hub-100', 0.0677)]),
      ];
      const result = deduplicateHubSpokeBreakdowns(groups);
      assert.equal(result.length, 1);
      assert.equal(result[0].opportunityType, 'AAVE_V4_HUB_SUPPLY');
    });
  });

  describe('scenario 4: only Spoke → keep Spoke', () => {
    it('keeps Spoke group when no Hub group exists', () => {
      const groups = [
        mkGroup('AAVE_V4_SPOKE_SUPPLY', [mkBreakdown('spoke-200', 0.0648, 'hub-100')]),
      ];
      const result = deduplicateHubSpokeBreakdowns(groups);
      assert.equal(result.length, 1);
      assert.equal(result[0].opportunityType, 'AAVE_V4_SPOKE_SUPPLY');
    });
  });

  describe('scenario 5: Hub with multiple breakdowns, only one is parent', () => {
    it('removes only the parent Hub breakdown, keeps independent Hub breakdowns', () => {
      const PARENT_HUB_ID = 'hub-100';
      const INDEPENDENT_HUB_ID = 'hub-300';
      const SPOKE_ID = 'spoke-200';
      const groups = [
        mkGroup('AAVE_V4_HUB_SUPPLY', [
          mkBreakdown(PARENT_HUB_ID, 0.0677),
          mkBreakdown(INDEPENDENT_HUB_ID, 0.055),
        ]),
        mkGroup('AAVE_V4_SPOKE_SUPPLY', [mkBreakdown(SPOKE_ID, 0.0648, PARENT_HUB_ID)]),
      ];
      const result = deduplicateHubSpokeBreakdowns(groups);
      // Hub group kept with only the independent breakdown
      const hubGroup = result.find(g => g.opportunityType === 'AAVE_V4_HUB_SUPPLY');
      assert.ok(hubGroup, 'Hub group should still exist');
      assert.equal(hubGroup!.breakdowns.length, 1);
      assert.equal(hubGroup!.breakdowns[0].campaignId, INDEPENDENT_HUB_ID);
      // Spoke group also kept
      assert.ok(result.some(g => g.opportunityType === 'AAVE_V4_SPOKE_SUPPLY'));
    });
  });

  describe('scenario 6: non-V4 groups pass through untouched', () => {
    it('keeps V3 and other non-V4 groups without dedup', () => {
      const groups = [
        mkGroup('AAVE_SUPPLY', [mkBreakdown('v3-1', 0.05)]),
        mkGroup('AAVE_V4_HUB_SUPPLY', [mkBreakdown('hub-100', 0.0677)]),
        mkGroup('AAVE_V4_SPOKE_SUPPLY', [mkBreakdown('spoke-200', 0.0648, 'hub-100')]),
        mkGroup('MULTILOG_DUTCH', [mkBreakdown('multi-1', 0.03)]),
      ];
      const result = deduplicateHubSpokeBreakdowns(groups);
      // V3 and MULTILOG_DUTCH kept, Hub removed, Spoke kept
      assert.equal(result.length, 3);
      assert.ok(result.some(g => g.opportunityType === 'AAVE_SUPPLY'));
      assert.ok(result.some(g => g.opportunityType === 'AAVE_V4_SPOKE_SUPPLY'));
      assert.ok(result.some(g => g.opportunityType === 'MULTILOG_DUTCH'));
      assert.ok(!result.some(g => g.opportunityType === 'AAVE_V4_HUB_SUPPLY'));
    });
  });

  describe('scenario 7: empty input', () => {
    it('returns empty array for empty input', () => {
      const result = deduplicateHubSpokeBreakdowns([]);
      assert.equal(result.length, 0);
    });
  });

  describe('scenario 8: Hub group entirely replaced → group dropped', () => {
    it('drops Hub group when all its breakdowns are parents of matched Spokes', () => {
      const HUB_ID_A = 'hub-a';
      const HUB_ID_B = 'hub-b';
      const groups = [
        mkGroup('AAVE_V4_HUB_SUPPLY', [
          mkBreakdown(HUB_ID_A, 0.0677),
          mkBreakdown(HUB_ID_B, 0.0536),
        ]),
        mkGroup('AAVE_V4_SPOKE_SUPPLY', [
          mkBreakdown('spoke-a', 0.0648, HUB_ID_A),
          mkBreakdown('spoke-b', 0.0487, HUB_ID_B),
        ]),
      ];
      const result = deduplicateHubSpokeBreakdowns(groups);
      // Hub group dropped (all breakdowns replaced), only Spoke group remains
      assert.equal(result.length, 1);
      assert.equal(result[0].opportunityType, 'AAVE_V4_SPOKE_SUPPLY');
      assert.equal(result[0].breakdowns.length, 2);
    });
  });

  describe('scenario 9: multiple Spoke groups referencing same Hub campaignId', () => {
    it('aggregates parentCampaignIds across Spoke groups correctly', () => {
      const HUB_ID = 'hub-100';
      const groups = [
        mkGroup('AAVE_V4_HUB_SUPPLY', [mkBreakdown(HUB_ID, 0.0677)]),
        mkGroup('AAVE_V4_SPOKE_SUPPLY', [mkBreakdown('spoke-a', 0.0648, HUB_ID)]),
        mkGroup('AAVE_V4_SPOKE_SUPPLY', [mkBreakdown('spoke-b', 0.0600, HUB_ID)], '9876543210'),
      ];
      const result = deduplicateHubSpokeBreakdowns(groups);
      // Both Spoke groups kept, Hub group dropped
      assert.equal(result.length, 2);
      assert.ok(result.every(g => g.opportunityType === 'AAVE_V4_SPOKE_SUPPLY'));
    });
  });

  describe('scenario 10: BORROW side opportunityType variants', () => {
    it('deduplicates AAVE_V4_HUB_BORROW + AAVE_V4_SPOKE_BORROW correctly', () => {
      const HUB_ID = 'hub-borrow-100';
      const SPOKE_ID = 'spoke-borrow-200';
      const groups = [
        mkGroup('AAVE_V4_HUB_BORROW', [mkBreakdown(HUB_ID, 0.03)]),
        mkGroup('AAVE_V4_SPOKE_BORROW', [mkBreakdown(SPOKE_ID, 0.025, HUB_ID)]),
      ];
      const result = deduplicateHubSpokeBreakdowns(groups);
      assert.equal(result.length, 1);
      assert.equal(result[0].opportunityType, 'AAVE_V4_SPOKE_BORROW');
      assert.equal(result[0].breakdowns[0].campaignId, SPOKE_ID);
    });
  });
});
