import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildForecastState,
  normalizeCampaignType,
} from '../src/services/merklForecastModel.js';

test('normalizeCampaignType: distributionMethod takes priority', () => {
  assert.equal(
    normalizeCampaignType({ distributionMethod: 'MAX_APR' }),
    'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  );
  assert.equal(
    normalizeCampaignType({ distributionMethod: 'FIX_APR' }),
    'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  );
  assert.equal(
    normalizeCampaignType({ distributionMethod: 'DUTCH_AUCTION' }),
    'DUTCH_AUCTION'
  );
  assert.equal(normalizeCampaignType({ distributionMethod: 'AIRDROP' }), null);
});

test('normalizeCampaignType: distributionType fallback', () => {
  assert.equal(
    normalizeCampaignType({ distributionType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' }),
    'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  );
  assert.equal(
    normalizeCampaignType({ distributionType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT' }),
    'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  );
  assert.equal(
    normalizeCampaignType({ distributionType: 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE' }),
    'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  );
  assert.equal(
    normalizeCampaignType({ distributionType: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE' }),
    'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  );
  assert.equal(
    normalizeCampaignType({ distributionType: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT' }),
    'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  );
  assert.equal(
    normalizeCampaignType({ distributionType: 'DUTCH_AUCTION' }),
    'DUTCH_AUCTION'
  );
});

test('normalizeCampaignType: new AAVE/ERC4626 types', () => {
  assert.equal(
    normalizeCampaignType({ distributionType: 'AAVE_NET_APR' }),
    'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  );
  assert.equal(
    normalizeCampaignType({ distributionType: 'AAVE_V4_NET_APR' }),
    'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  );
  assert.equal(
    normalizeCampaignType({ distributionType: 'ERC4626_APR' }),
    'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  );
});

test('normalizeCampaignType: mode fallback', () => {
  assert.equal(
    normalizeCampaignType({ mode: 'MAX_APR' }),
    'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  );
  assert.equal(
    normalizeCampaignType({ mode: 'FIX_APR' }),
    'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  );
});

test('normalizeCampaignType: priority method > type > mode', () => {
  assert.equal(
    normalizeCampaignType({ distributionMethod: 'FIX_APR', distributionType: 'DUTCH_AUCTION', mode: 'MAX_APR' }),
    'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  );
  assert.equal(
    normalizeCampaignType({ distributionMethod: 'AIRDROP', distributionType: 'DUTCH_AUCTION', mode: 'MAX_APR' }),
    'DUTCH_AUCTION'
  );
  assert.equal(
    normalizeCampaignType({ distributionMethod: 'AIRDROP', distributionType: 'AAVE_NET_APR', mode: 'FIX_APR' }),
    'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
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
  // Internal model still computes requiredDaily; controller omits it from API for DUTCH.
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

test('buildForecastState requires apr cap input for FIX campaigns and stores it in aprCap field', () => {
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
