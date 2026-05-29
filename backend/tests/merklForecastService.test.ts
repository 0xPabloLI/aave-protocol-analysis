import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractDailyRewardsRecords,
  extractNormalizedTotalBudget,
  buildCampaignOpportunityMetaMapFromOpportunities,
} from '../src/services/merklForecastService.js';

test('extractNormalizedTotalBudget converts reward amount to USD using token price', () => {
  const totalBudget = extractNormalizedTotalBudget(
    {
      amount: '8751600000000',
      rewardToken: {
        decimals: 6,
        price: 0.09649290708326991,
      },
    },
    'test-campaign'
  );

  assert.equal(totalBudget, 844467.3256299449);
});

test('extractNormalizedTotalBudget falls back to token amount when price is missing', () => {
  const totalBudget = extractNormalizedTotalBudget(
    {
      amount: '1000000000000000000000',
      rewardToken: {
        decimals: 18,
      },
    },
    'test-campaign'
  );

  assert.equal(totalBudget, 1000);
});

test('extractDailyRewardsRecords uses totalInToken for points campaigns when flagged', () => {
  const records = extractDailyRewardsRecords(
    {
      dailyRewardsRecords: [
        {
          timestamp: '1774518967',
          total: 0,
          totalInToken: 7070,
        },
      ],
    },
    true
  );

  assert.deepEqual(records, [{ timestamp: 1774518967, total: 7070 }]);
});

test('extractDailyRewardsRecords keeps using total for non-points campaigns', () => {
  const records = extractDailyRewardsRecords(
    {
      dailyRewardsRecords: [
        {
          timestamp: '1774518967',
          total: 12.5,
          totalInToken: 7070,
        },
      ],
    },
    false
  );

  assert.deepEqual(records, [{ timestamp: 1774518967, total: 12.5 }]);
});

test('buildCampaignOpportunityMetaMapFromOpportunities: extracts breakdown distributionType and distributionMethod', () => {
  const opps = [{
    tvl: 1000,
    distributionType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE',
    rewardsRecord: { breakdowns: [{ campaignId: 'c1', distributionType: 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE', distributionMethod: 'FIX_APR' }] },
    campaigns: [],
  }];
  const map = buildCampaignOpportunityMetaMapFromOpportunities(opps as any);
  assert.ok(map.has('c1'));
  assert.equal(map.get('c1')!.campaignTypeHint, 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE');
});

test('buildCampaignOpportunityMetaMapFromOpportunities: falls back to opportunity-level distributionType', () => {
  const opps = [{
    tvl: 1000,
    distributionType: 'DUTCH_AUCTION',
    rewardsRecord: { breakdowns: [{ campaignId: 'c1' }] },
    campaigns: [],
  }];
  const map = buildCampaignOpportunityMetaMapFromOpportunities(opps as any);
  assert.ok(map.has('c1'));
  assert.equal(map.get('c1')!.campaignTypeHint, 'DUTCH_AUCTION');
});

test('buildCampaignOpportunityMetaMapFromOpportunities: extracts mode from campaign params', () => {
  const opps = [{
    tvl: 1000,
    distributionType: 'AAVE_NET_APR',
    rewardsRecord: { breakdowns: [{ campaignId: 'c1', distributionType: 'AAVE_NET_APR' }] },
    campaigns: [{ id: 'c1', params: { distributionMethodParameters: { distributionSettings: { mode: 'MAX_APR' } } } }],
  }];
  const map = buildCampaignOpportunityMetaMapFromOpportunities(opps as any);
  assert.ok(map.has('c1'));
  assert.equal(map.get('c1')!.campaignTypeHint, 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE');
});

test('buildCampaignOpportunityMetaMapFromOpportunities: distributionMethod on breakdown takes priority over distributionType', () => {
  const opps = [{
    tvl: 1000,
    rewardsRecord: { breakdowns: [{ campaignId: 'c1', distributionType: 'DUTCH_AUCTION', distributionMethod: 'MAX_APR' }] },
    campaigns: [],
  }];
  const map = buildCampaignOpportunityMetaMapFromOpportunities(opps as any);
  assert.ok(map.has('c1'));
  assert.equal(map.get('c1')!.campaignTypeHint, 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE');
});

test('buildCampaignOpportunityMetaMapFromOpportunities: AAVE_V4_NET_APR with mode=MAX_APR maps to MAX', () => {
  const opps = [{
    tvl: 1000,
    distributionType: 'AAVE_V4_NET_APR',
    rewardsRecord: { breakdowns: [{ campaignId: 'c1', distributionType: 'AAVE_V4_NET_APR' }] },
    campaigns: [{ id: 'c1', params: { distributionMethodParameters: { distributionSettings: { mode: 'MAX_APR' } } } }],
  }];
  const map = buildCampaignOpportunityMetaMapFromOpportunities(opps as any);
  assert.ok(map.has('c1'));
  assert.equal(map.get('c1')!.campaignTypeHint, 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE');
});

test('buildCampaignOpportunityMetaMapFromOpportunities: unknown type with no method/mode is skipped', () => {
  const opps = [{
    tvl: 1000,
    rewardsRecord: { breakdowns: [{ campaignId: 'c1', distributionType: 'TOTALLY_UNKNOWN' }] },
    campaigns: [],
  }];
  const map = buildCampaignOpportunityMetaMapFromOpportunities(opps as any);
  assert.ok(!map.has('c1'));
});

test('buildCampaignOpportunityMetaMapFromOpportunities: zero tvl opportunity is NOT skipped (only null/negative skipped)', () => {
  const opps = [{
    tvl: 0,
    rewardsRecord: { breakdowns: [{ campaignId: 'c1', distributionType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' }] },
    campaigns: [],
  }];
  const map = buildCampaignOpportunityMetaMapFromOpportunities(opps as any);
  assert.ok(map.has('c1'));
});

test('buildCampaignOpportunityMetaMapFromOpportunities: mode path extraction via deep nested params', () => {
  const modePath = { distributionMethodParameters: { distributionSettings: { mode: 'MAX_APR' } } };
  const opps = [{
    tvl: 1000,
    distributionType: 'AAVE_NET_APR',
    rewardsRecord: { breakdowns: [{ campaignId: 'c1', distributionType: 'AAVE_NET_APR' }] },
    campaigns: [{ id: 'c1', params: modePath }],
  }];
  const map = buildCampaignOpportunityMetaMapFromOpportunities(opps as any);
  assert.ok(map.has('c1'));
  assert.equal(map.get('c1')!.campaignTypeHint, 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE');
});

test('buildCampaignOpportunityMetaMapFromOpportunities: mode determines type when distributionType has no explicit mapping', () => {
  const modePath = { distributionMethodParameters: { distributionSettings: { mode: 'FIX_APR' } } };
  const opps = [{
    tvl: 1000,
    distributionType: 'FUTURE_UNKNOWN_TYPE',
    rewardsRecord: { breakdowns: [{ campaignId: 'c1', distributionType: 'FUTURE_UNKNOWN_TYPE' }] },
    campaigns: [{ id: 'c1', params: modePath }],
  }];
  const map = buildCampaignOpportunityMetaMapFromOpportunities(opps as any);
  assert.ok(map.has('c1'));
  assert.equal(map.get('c1')!.campaignTypeHint, 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE');
});
