import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pruneMerklGroup, pruneBrevisItem } from '../src/incentive-prune.js';
import type {
  MerklOpportunityGroup,
  BrevisCampaignItem,
} from '@internal/aave-shared-contracts';

describe('arch-2: incentive-prune', () => {
  describe('pruneMerklGroup', () => {
    it('keeps required fields and breakdowns', () => {
      const g: MerklOpportunityGroup = {
        link: 'https://merkl',
        breakdowns: [{ campaignApr: 0.04, campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31', campaignId: 'c1' }],
      };
      const r = pruneMerklGroup(g);
      assert.equal(r.link, 'https://merkl');
      assert.equal(r.breakdowns.length, 1);
      assert.equal(r.breakdowns[0].campaignApr, 0.04);
      assert.equal(r.breakdowns[0].campaignId, 'c1');
    });

    it('preserves opportunityType (bug fix)', () => {
      const g: MerklOpportunityGroup = {
        link: 'https://merkl',
        opportunityType: 'NET',
        breakdowns: [],
      };
      const r = pruneMerklGroup(g);
      assert.equal(r.opportunityType, 'NET');
    });

    it('omits opportunityType when absent', () => {
      const g: MerklOpportunityGroup = { link: 'https://merkl', breakdowns: [] };
      const r = pruneMerklGroup(g);
      assert.equal('opportunityType' in r, false);
    });

    it('keeps rewardTokenSymbol and rewardTokenIconUrl when present', () => {
      const g: MerklOpportunityGroup = {
        link: 'https://merkl',
        breakdowns: [{
          campaignApr: 0.04,
          campaignStartedAt: '2025-01-01',
          campaignEndedAt: '2025-12-31',
          campaignId: 'c1',
          rewardTokenSymbol: 'TydroInkPoints',
          rewardTokenIconUrl: 'https://example.com/ink.svg',
        }],
      };
      const r = pruneMerklGroup(g);
      assert.equal(r.breakdowns[0].rewardTokenSymbol, 'TydroInkPoints');
      assert.equal(r.breakdowns[0].rewardTokenIconUrl, 'https://example.com/ink.svg');
    });

    it('omits rewardTokenSymbol and rewardTokenIconUrl when absent', () => {
      const g: MerklOpportunityGroup = {
        link: 'https://merkl',
        breakdowns: [{ campaignApr: 0.04, campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31', campaignId: 'c1' }],
      };
      const r = pruneMerklGroup(g);
      assert.equal('rewardTokenSymbol' in r.breakdowns[0], false);
      assert.equal('rewardTokenIconUrl' in r.breakdowns[0], false);
    });

    it('keeps optional name/message on group', () => {
      const g: MerklOpportunityGroup = {
        link: 'https://merkl',
        name: 'test',
        message: 'desc',
        breakdowns: [],
      };
      const r = pruneMerklGroup(g);
      assert.equal(r.name, 'test');
      assert.equal(r.message, 'desc');
    });
  });

  describe('pruneBrevisItem', () => {
    it('keeps required fields and breakdowns', () => {
      const g: BrevisCampaignItem = {
        link: 'https://brevis',
        breakdowns: [{ campaignApr: 0.03, campaignStartedAt: '2025-01-01', campaignEndedAt: '2025-12-31' }],
      };
      const r = pruneBrevisItem(g);
      assert.equal(r.link, 'https://brevis');
      assert.equal(r.breakdowns.length, 1);
      assert.equal(r.breakdowns[0].campaignApr, 0.03);
    });

    it('keeps optional breakdown fields', () => {
      const g: BrevisCampaignItem = {
        link: 'https://brevis',
        breakdowns: [{
          campaignApr: 0.03,
          campaignStartedAt: '2025-01-01',
          campaignEndedAt: '2025-12-31',
          latestTvl: 1000,
          totalBudget: 500,
          campaignId: 'c1',
        }],
      };
      const r = pruneBrevisItem(g);
      assert.equal(r.breakdowns[0].latestTvl, 1000);
      assert.equal(r.breakdowns[0].totalBudget, 500);
      assert.equal(r.breakdowns[0].campaignId, 'c1');
    });

    it('keeps optional name/message on item', () => {
      const g: BrevisCampaignItem = {
        link: 'https://brevis',
        name: 'test',
        message: 'desc',
        breakdowns: [],
      };
      const r = pruneBrevisItem(g);
      assert.equal(r.name, 'test');
      assert.equal(r.message, 'desc');
    });
  });
});
