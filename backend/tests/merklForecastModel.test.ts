import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildForecastState,
  normalizeCampaignType,
} from '../src/services/merklForecastModel.js';

const TTA = 'TARGET_TOTAL_APR' as const;

test('normalizeCampaignType: Level 2 distributionType exact match', () => {
  assert.equal(
    normalizeCampaignType({ distributionType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' }),
    'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  );
  assert.equal(
    normalizeCampaignType({ distributionType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT' }),
    'MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT'
  );
  assert.equal(
    normalizeCampaignType({ distributionType: 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE' }),
    'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  );
  assert.equal(
    normalizeCampaignType({ distributionType: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE' }),
    'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE'
  );
  assert.equal(
    normalizeCampaignType({ distributionType: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT' }),
    'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT'
  );
  assert.equal(
    normalizeCampaignType({ distributionType: 'DUTCH_AUCTION' }),
    'DUTCH_AUCTION'
  );
});

test('normalizeCampaignType: 7 Target Total APR distributionType values map to TARGET_TOTAL_APR via L2', () => {
  const types = [
    'AAVE_NET_APR',
    'AAVE_V4_NET_APR',
    'ERC4626_APR',
    'ERC4626_SPREAD_CAPPED',
    'ERC4626_TARGET_APR_WITH_MERKL',
    'SOFR_SPREAD_RATCHET',
    'DEEL_DISTRIBUTION',
  ];
  for (const t of types) {
    assert.equal(
      normalizeCampaignType({ distributionType: t }),
      TTA,
      `distributionType=${t} should map to TARGET_TOTAL_APR`,
    );
  }
});

test('normalizeCampaignType: Level 3 targetAPR fallback classifies as TARGET_TOTAL_APR', () => {
  assert.equal(
    normalizeCampaignType({ targetAPR: 5.0 }),
    TTA,
    'positive number targetAPR should classify as TARGET_TOTAL_APR',
  );
  assert.equal(
    normalizeCampaignType({ targetAPR: '3.5' }),
    TTA,
    'positive string targetAPR should classify as TARGET_TOTAL_APR',
  );
  assert.equal(
    normalizeCampaignType({ distributionType: 'UNKNOWN_NEW_TYPE', targetAPR: 2.0 }),
    TTA,
    'Level 3 fallback activates when Level 2 misses',
  );
});

test('normalizeCampaignType: Level 3 targetAPR fallback does NOT activate for invalid values', () => {
  assert.equal(
    normalizeCampaignType({ targetAPR: 0 }),
    null,
    'targetAPR=0 should not trigger Level 3',
  );
  assert.equal(
    normalizeCampaignType({ targetAPR: -1 }),
    null,
    'negative targetAPR should not trigger Level 3',
  );
  assert.equal(
    normalizeCampaignType({ targetAPR: NaN }),
    null,
    'NaN targetAPR should not trigger Level 3',
  );
  assert.equal(
    normalizeCampaignType({ targetAPR: 'not a number' }),
    null,
    'non-numeric string targetAPR should not trigger Level 3',
  );
  assert.equal(
    normalizeCampaignType({ targetAPR: undefined }),
    null,
    'undefined targetAPR should not trigger Level 3',
  );
});

test('normalizeCampaignType: Level 2 takes priority over Level 3', () => {
  assert.equal(
    normalizeCampaignType({ distributionType: 'DUTCH_AUCTION', targetAPR: 5.0 }),
    'DUTCH_AUCTION',
    'Level 2 match should win over Level 3 fallback',
  );
  assert.equal(
    normalizeCampaignType({ distributionType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE', targetAPR: 5.0 }),
    'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE',
    'Level 2 match should win over Level 3 fallback',
  );
});

test('normalizeCampaignType: distributionMethod is no longer used (Level 1 removed)', () => {
  assert.equal(
    normalizeCampaignType({ distributionMethod: 'MAX_APR' } as any),
    null,
    'distributionMethod should be ignored after Level 1 removal',
  );
  assert.equal(
    normalizeCampaignType({ distributionMethod: 'AAVE_NET_APR' } as any),
    null,
    'distributionMethod should be ignored after Level 1 removal',
  );
});

test('normalizeCampaignType: null/invalid inputs', () => {
  assert.equal(normalizeCampaignType({}), null);
  assert.equal(normalizeCampaignType(null), null);
  assert.equal(normalizeCampaignType(undefined), null);
  assert.equal(normalizeCampaignType('string'), null);
  assert.equal(normalizeCampaignType({ distributionType: 'UNKNOWN_TYPE' }), null);
});

test('buildForecastState supports DUTCH_AUCTION without apr cap', () => {
  const state = buildForecastState({
    campaignId: 'dutch-1',
    campaignType: 'DUTCH_AUCTION',
    totalBudget: 1000,
    aprCap: null,
    startTimestamp: 1_000,
    endTimestamp: 1_000 + 10 * 86400,
    nowTimestamp: 1_000 + 5 * 86400,
    distributedSoFar: 400,
    latestTvl: 2_000_000,
  });

  assert.equal(state.campaignType, 'DUTCH_AUCTION');
  assert.equal(state.aprCap, null);
  assert.equal(state.remainingBudget, 600);
  assert.equal(state.remainingDays, 5);
  assert.equal(state.plannedDaily, 100);
  assert.equal(state.requiredDaily, state.plannedDaily);
});

test('buildForecastState requires apr cap for MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE campaigns', () => {
  assert.throws(
    () =>
      buildForecastState({
        campaignId: 'max-apr-1',
        campaignType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE',
        totalBudget: 1000,
        aprCap: null,
        startTimestamp: 1_000,
        endTimestamp: 1_000 + 10 * 86400,
        nowTimestamp: 1_000 + 5 * 86400,
        distributedSoFar: 500,
        latestTvl: 1_000_000,
      }),
    /Missing APR cap/
  );
});

test('buildForecastState requires apr cap for FIX campaigns and stores it in aprCap field', () => {
  assert.throws(
    () =>
      buildForecastState({
        campaignId: 'fix-1',
        campaignType: 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE',
        totalBudget: 1000,
        aprCap: null,
        startTimestamp: 1_000,
        endTimestamp: 1_000 + 10 * 86400,
        nowTimestamp: 1_000 + 5 * 86400,
        distributedSoFar: 300,
        latestTvl: 1_000_000,
      }),
    /Missing APR cap/
  );

  const state = buildForecastState({
    campaignId: 'fix-2',
    campaignType: 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE',
    totalBudget: 1000,
    aprCap: 0.005,
    startTimestamp: 1_000,
    endTimestamp: 1_000 + 10 * 86400,
    nowTimestamp: 1_000 + 5 * 86400,
    distributedSoFar: 300,
    latestTvl: 1_000_000,
  });
  assert.equal(state.aprCap, 0.005);
  assert.equal(state.plannedDaily, 100);
  assert.equal(state.requiredDaily, 140);
});

test('buildForecastState requires apr cap for TARGET_TOTAL_APR campaigns', () => {
  assert.throws(
    () =>
      buildForecastState({
        campaignId: 'tta-1',
        campaignType: 'TARGET_TOTAL_APR',
        totalBudget: 1000,
        aprCap: null,
        startTimestamp: 1_000,
        endTimestamp: 1_000 + 10 * 86400,
        nowTimestamp: 1_000 + 5 * 86400,
        distributedSoFar: 300,
        latestTvl: 1_000_000,
      }),
    /Missing APR cap/
  );
});

test('buildForecastState computes TARGET_TOTAL_APR forecast correctly', () => {
  const state = buildForecastState({
    campaignId: 'tta-2',
    campaignType: 'TARGET_TOTAL_APR',
    totalBudget: 5000,
    aprCap: 0.047,
    startTimestamp: 1_000,
    endTimestamp: 1_000 + 10 * 86400,
    nowTimestamp: 1_000 + 5 * 86400,
    distributedSoFar: 2000,
    latestTvl: 1_000_000,
  });
  assert.equal(state.aprCap, 0.047);
  assert.equal(state.remainingBudget, 3000);
  assert.equal(state.plannedDaily, 500);
  assert.equal(state.requiredDaily, 600);
});

test('buildForecastState requires apr cap for FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE', () => {
  assert.throws(
    () =>
      buildForecastState({
        campaignId: 'fix-amt-val-1',
        campaignType: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE',
        totalBudget: 1000,
        aprCap: null,
        startTimestamp: 1_000,
        endTimestamp: 1_000 + 10 * 86400,
        nowTimestamp: 1_000 + 5 * 86400,
        distributedSoFar: 300,
        latestTvl: 1_000_000,
      }),
    /Missing APR cap/
  );
});

test('buildForecastState accepts USD-converted aprCap for FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE', () => {
  const state = buildForecastState({
    campaignId: 'fix-amt-val-2',
    campaignType: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE',
    totalBudget: 5000,
    aprCap: 0.035,
    startTimestamp: 1_000,
    endTimestamp: 1_000 + 10 * 86400,
    nowTimestamp: 1_000 + 5 * 86400,
    distributedSoFar: 1000,
    latestTvl: 2_000_000,
  });
  assert.equal(state.aprCap, 0.035);
  assert.equal(state.plannedDaily, 500);
});

test('buildForecastState requires apr cap for FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT', () => {
  assert.throws(
    () =>
      buildForecastState({
        campaignId: 'fix-amt-amt-1',
        campaignType: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT',
        totalBudget: 1000,
        aprCap: null,
        startTimestamp: 1_000,
        endTimestamp: 1_000 + 10 * 86400,
        nowTimestamp: 1_000 + 5 * 86400,
        distributedSoFar: 300,
        latestTvl: 1_000_000,
      }),
    /Missing APR cap/
  );
});

test('buildForecastState requires apr cap for MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT', () => {
  assert.throws(
    () =>
      buildForecastState({
        campaignId: 'max-val-amt-1',
        campaignType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT',
        totalBudget: 1000,
        aprCap: null,
        startTimestamp: 1_000,
        endTimestamp: 1_000 + 10 * 86400,
        nowTimestamp: 1_000 + 5 * 86400,
        distributedSoFar: 300,
        latestTvl: 1_000_000,
      }),
    /Missing APR cap/
  );
});
