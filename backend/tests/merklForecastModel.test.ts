import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildForecastState,
  normalizeCampaignType,
} from '../src/services/merklForecastModel.js';

const TTA = 'TARGET_TOTAL_APR' as const;

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
  assert.equal(
    normalizeCampaignType({ distributionMethod: 'AIRDROP' }),
    null
  );
});

test('normalizeCampaignType: distributionType fallback when method unrecognized', () => {
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

test('normalizeCampaignType: 7 Target Total APR distributionMethod values map to TARGET_TOTAL_APR via L1', () => {
  const methods = [
    'AAVE_NET_APR',
    'AAVE_V4_NET_APR',
    'ERC4626_APR',
    'ERC4626_SPREAD_CAPPED',
    'ERC4626_TARGET_APR_WITH_MERKL',
    'SOFR_SPREAD_RATCHET',
    'DEEL_DISTRIBUTION',
  ];
  for (const method of methods) {
    assert.equal(
      normalizeCampaignType({ distributionMethod: method }),
      TTA,
      `distributionMethod=${method} should map to TARGET_TOTAL_APR`,
    );
  }
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

test('normalizeCampaignType: L3 mode mapping removed — mode is no longer a type signal', () => {
  assert.equal(
    normalizeCampaignType({ mode: 'MAX_APR' }),
    null,
    'mode=MAX_APR should no longer resolve via L3',
  );
  assert.equal(
    normalizeCampaignType({ mode: 'FIX_APR' }),
    null,
    'mode=FIX_APR should no longer resolve via L3',
  );
  assert.equal(
    normalizeCampaignType({ distributionType: 'AAVE_NET_APR', mode: 'MAX_APR' }),
    TTA,
    'L2 should still resolve; mode is ignored',
  );
});

test('normalizeCampaignType: priority order method > type', () => {
  assert.equal(
    normalizeCampaignType({ distributionMethod: 'FIX_APR', distributionType: 'DUTCH_AUCTION' }),
    'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  );
  assert.equal(
    normalizeCampaignType({ distributionMethod: 'AIRDROP', distributionType: 'DUTCH_AUCTION' }),
    'DUTCH_AUCTION'
  );
  assert.equal(
    normalizeCampaignType({ distributionMethod: 'AAVE_NET_APR', distributionType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' }),
    TTA
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
