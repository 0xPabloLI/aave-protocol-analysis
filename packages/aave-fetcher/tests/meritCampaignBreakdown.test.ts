import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPositionCapFromSelfAuth,
  buildMeritCampaignBreakdowns,
} from '../src/merit-api.js';

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
});
