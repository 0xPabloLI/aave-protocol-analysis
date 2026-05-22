import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pruneMeritEntry, pruneMerklGroup, pruneBrevisItem } from '../src/incentive-prune.js';
import type {
  MeritAprEntry,
  MerklOpportunityGroup,
  BrevisCampaignItem,
} from '@internal/aave-shared-contracts';

describe('arch-2: incentive-prune', () => {
  describe('pruneMeritEntry', () => {
    it('keeps required fields', () => {
      const e: MeritAprEntry = {
        apr: 0.05,
        link: 'https://merit',
        startDate: '2025-01-01',
        endDate: '2025-12-31',
      };
      const r = pruneMeritEntry(e);
      assert.equal(r.apr, 0.05);
      assert.equal(r.link, 'https://merit');
      assert.equal(r.startDate, '2025-01-01');
      assert.equal(r.endDate, '2025-12-31');
    });

    it('keeps optional fields when present', () => {
      const e: MeritAprEntry = {
        apr: 0.05,
        selfApr: 0.03,
        link: 'https://merit',
        startDate: '2025-01-01',
        endDate: '2025-12-31',
        name: 'test',
        lastRoundRewardUsd: 100,
        message: [{ action: 'supply', description: 'desc' }],
      };
      const r = pruneMeritEntry(e);
      assert.equal(r.selfApr, 0.03);
      assert.equal(r.name, 'test');
      assert.equal(r.lastRoundRewardUsd, 100);
      assert.deepEqual(r.message, [{ action: 'supply', description: 'desc' }]);
    });

    it('omits optional fields when undefined', () => {
      const e: MeritAprEntry = {
        apr: 0.05,
        link: 'https://merit',
        startDate: '2025-01-01',
        endDate: '2025-12-31',
      };
      const r = pruneMeritEntry(e);
      assert.equal('selfApr' in r, false);
      assert.equal('name' in r, false);
      assert.equal('lastRoundRewardUsd' in r, false);
      assert.equal('message' in r, false);
    });
  });

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
