import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPositionCapFromSelfAuth,
  buildMeritCampaignBreakdowns,
  buildCampaignGroupFromMeritEntry,
} from '../src/merit-api.js';
import type { MeritAprEntry } from '../src/merit-api.js';

describe('AAV-960: Merit format unification', () => {
  describe('extractPositionCapFromSelfAuth', () => {
    it('extracts $1,000 from self auth description', () => {
      const cap = extractPositionCapFromSelfAuth('Self authentication: Incentive on first $1,000 of deposit');
      assert.equal(cap, 1000);
    });

    it('extracts $10,000 from self auth description', () => {
      const cap = extractPositionCapFromSelfAuth('Incentive on first $10,000 for self-authenticated users');
      assert.equal(cap, 10000);
    });

    it('extracts decimal amount like $1,500.50', () => {
      const cap = extractPositionCapFromSelfAuth('Self auth cap: $1,500.50');
      assert.equal(cap, 1500.50);
    });

    it('returns null when no dollar amount found', () => {
      const cap = extractPositionCapFromSelfAuth('Self authentication required');
      assert.equal(cap, null);
    });

    it('returns null for null input', () => {
      const cap = extractPositionCapFromSelfAuth(null);
      assert.equal(cap, null);
    });

    it('returns null for empty string', () => {
      const cap = extractPositionCapFromSelfAuth('');
      assert.equal(cap, null);
    });

    it('ignores dollar amount without "self" keyword', () => {
      const cap = extractPositionCapFromSelfAuth('Incentive on first $1,000 of deposit');
      assert.equal(cap, null);
    });
  });

  describe('buildMeritCampaignBreakdowns', () => {
    it('splits base and self into two breakdowns', () => {
      const breakdowns = buildMeritCampaignBreakdowns({
        baseApr: 0.05,
        selfApr: 0.03,
        startDate: '2025-01-01',
        endDate: '2025-12-31',
        meritKey: 'ethereum-supply-weth',
        selfPositionCap: 1000,
      });
      assert.equal(breakdowns.length, 2);
      assert.equal(breakdowns[0].campaignApr, 0.05);
      assert.equal(breakdowns[0].campaignType, 'DUTCH_AUCTION');
      assert.equal(breakdowns[0].campaignId, 'ethereum-supply-weth-base');
      assert.equal('positionCap' in breakdowns[0], false);
      assert.equal(breakdowns[1].campaignApr, 0.03);
      assert.equal(breakdowns[1].campaignType, 'DUTCH_AUCTION');
      assert.equal(breakdowns[1].campaignId, 'ethereum-supply-weth-self');
      assert.equal(breakdowns[1].positionCap, 1000);
    });

    it('returns only base breakdown when selfApr is 0', () => {
      const breakdowns = buildMeritCampaignBreakdowns({
        baseApr: 0.05,
        selfApr: 0,
        startDate: '2025-01-01',
        endDate: '2025-12-31',
        meritKey: 'ethereum-supply-weth',
        selfPositionCap: null,
      });
      assert.equal(breakdowns.length, 1);
      assert.equal(breakdowns[0].campaignApr, 0.05);
      assert.equal(breakdowns[0].campaignId, 'ethereum-supply-weth-base');
    });

    it('returns only self breakdown when baseApr is 0', () => {
      const breakdowns = buildMeritCampaignBreakdowns({
        baseApr: 0,
        selfApr: 0.03,
        startDate: '2025-01-01',
        endDate: '2025-12-31',
        meritKey: 'ethereum-supply-weth',
        selfPositionCap: 1000,
      });
      assert.equal(breakdowns.length, 1);
      assert.equal(breakdowns[0].campaignApr, 0.03);
      assert.equal(breakdowns[0].campaignId, 'ethereum-supply-weth-self');
    });

    it('self breakdown without positionCap has no positionCap field', () => {
      const breakdowns = buildMeritCampaignBreakdowns({
        baseApr: 0,
        selfApr: 0.03,
        startDate: '2025-01-01',
        endDate: '2025-12-31',
        meritKey: 'ethereum-supply-weth',
        selfPositionCap: null,
      });
      assert.equal(breakdowns.length, 1);
      assert.equal('positionCap' in breakdowns[0], false);
    });
  });

  describe('buildCampaignGroupFromMeritEntry', () => {
    it('builds CampaignGroup from entry with self auth message', () => {
      const entry: MeritAprEntry = {
        apr: 0.05,
        selfApr: 0.03,
        link: 'https://apps.aavechan.com/merit/ethereum-supply-weth',
        startDate: '2025-01-01',
        endDate: '2025-12-31',
        name: 'Supply WETH',
        message: [
          { action: 'Supply WETH', description: 'Base rewards' },
          { action: 'Self Authentication', description: 'Incentive on first $1,000 of deposit' },
        ],
      };
      const group = buildCampaignGroupFromMeritEntry(entry, 'ethereum-supply-weth');
      assert.equal(group.link, 'https://apps.aavechan.com/merit/ethereum-supply-weth');
      assert.equal(group.name, 'Supply WETH');
      assert.equal('message' in group, false);
      assert.equal(group.breakdowns.length, 2);
      assert.equal(group.breakdowns[0].campaignApr, 0.05);
      assert.equal(group.breakdowns[0].campaignId, 'ethereum-supply-weth-base');
      assert.ok(group.breakdowns[0].message);
      assert.equal(group.breakdowns[1].campaignApr, 0.03);
      assert.equal(group.breakdowns[1].campaignId, 'ethereum-supply-weth-self');
      assert.equal(group.breakdowns[1].positionCap, 1000);
      assert.ok(group.breakdowns[1].message);
    });

    it('builds CampaignGroup from entry without self auth', () => {
      const entry: MeritAprEntry = {
        apr: 0.05,
        link: 'https://apps.aavechan.com/merit/ethereum-supply-weth',
        startDate: '2025-01-01',
        endDate: '2025-12-31',
      };
      const group = buildCampaignGroupFromMeritEntry(entry, 'ethereum-supply-weth');
      assert.equal(group.breakdowns.length, 1);
      assert.equal(group.breakdowns[0].campaignApr, 0.05);
      assert.equal('positionCap' in group.breakdowns[0], false);
    });

    it('builds CampaignGroup from entry with empty message', () => {
      const entry: MeritAprEntry = {
        apr: 0.05,
        selfApr: 0.02,
        link: 'https://apps.aavechan.com/merit/ethereum-supply-weth',
        startDate: '2025-01-01',
        endDate: '2025-12-31',
        message: [],
      };
      const group = buildCampaignGroupFromMeritEntry(entry, 'ethereum-supply-weth');
      assert.equal(group.breakdowns.length, 2);
      assert.equal('positionCap' in group.breakdowns[1], false);
    });

    it('does not set breakdown message when entry has no message', () => {
      const entry: MeritAprEntry = {
        apr: 0.05,
        link: 'https://apps.aavechan.com/merit/ethereum-supply-weth',
        startDate: '2025-01-01',
        endDate: '2025-12-31',
      };
      const group = buildCampaignGroupFromMeritEntry(entry, 'ethereum-supply-weth');
      assert.equal('message' in group, false);
      assert.equal('message' in group.breakdowns[0], false);
    });

    it('distributes self auth message to self breakdown and base message to base breakdown', () => {
      const entry: MeritAprEntry = {
        apr: 0.05,
        selfApr: 0.03,
        link: 'https://apps.aavechan.com/merit/ethereum-supply-weth',
        startDate: '2025-01-01',
        endDate: '2025-12-31',
        name: 'Supply WETH',
        message: [
          { action: 'Supply WETH', description: 'Rewards are distributed using the following formula: f(USD₮ aToken Holding - USD₮ vToken Holding / USD₮ Liquidation Threshold)' },
          { action: 'Self Authentication', description: 'Supply USDT and double your yield by verifying your humanity through Self for the first $1,000 USDT supplied per user.' },
        ],
      };
      const group = buildCampaignGroupFromMeritEntry(entry, 'ethereum-supply-weth');
      assert.equal(group.breakdowns.length, 2);

      // Base breakdown: has breakdown-level message with base entry
      assert.ok(group.breakdowns[0].message);
      const baseMsg = JSON.parse(group.breakdowns[0].message!);
      assert.equal(baseMsg.length, 1);
      assert.equal(baseMsg[0].action, 'Supply WETH');

      // Self breakdown: has breakdown-level message with self auth entry
      assert.ok(group.breakdowns[1].message);
      const selfMsg = JSON.parse(group.breakdowns[1].message!);
      assert.equal(selfMsg.length, 1);
      assert.equal(selfMsg[0].action, 'Self Authentication');

      // Opportunity-level message: not set (all distributed to breakdowns)
      assert.equal('message' in group, false);
    });

    it('distributes base message to base breakdown when no self auth exists', () => {
      const entry: MeritAprEntry = {
        apr: 0.05,
        selfApr: 0.03,
        link: 'https://apps.aavechan.com/merit/ethereum-supply-weth',
        startDate: '2025-01-01',
        endDate: '2025-12-31',
        message: [
          { action: 'Supply WETH', description: 'Base rewards formula' },
        ],
      };
      const group = buildCampaignGroupFromMeritEntry(entry, 'ethereum-supply-weth');
      assert.equal(group.breakdowns.length, 2);
      assert.ok(group.breakdowns[0].message);
      const baseMsg = JSON.parse(group.breakdowns[0].message!);
      assert.equal(baseMsg.length, 1);
      assert.equal(baseMsg[0].action, 'Supply WETH');
      assert.equal('message' in group.breakdowns[1], false);
      assert.equal('message' in group, false);
    });

    it('sets breakdown message even without positionCap', () => {
      const entry: MeritAprEntry = {
        apr: 0.05,
        selfApr: 0.03,
        link: 'https://apps.aavechan.com/merit/ethereum-supply-weth',
        startDate: '2025-01-01',
        endDate: '2025-12-31',
        message: [
          { action: 'Self Authentication', description: 'Verify your humanity through Self' },
        ],
      };
      const group = buildCampaignGroupFromMeritEntry(entry, 'ethereum-supply-weth');
      assert.equal(group.breakdowns.length, 2);
      assert.equal('positionCap' in group.breakdowns[1], false);
      assert.ok(group.breakdowns[1].message);
    });
  });
});
