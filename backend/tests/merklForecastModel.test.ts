import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildForecastState,
  normalizeCampaignType,
  resolveCampaignType,
} from '../src/services/merklForecastModel.js';

test('normalizeCampaignType maps max-apr, dutch and fix types', () => {
  assert.equal(
    normalizeCampaignType('MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE'),
    'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  );
  assert.equal(normalizeCampaignType('MAX_APR'), 'UNSUPPORTED');
  assert.equal(normalizeCampaignType('DUTCH_AUCTION'), 'DUTCH_AUCTION');
  assert.equal(
    normalizeCampaignType('FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'),
    'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  );
  assert.equal(normalizeCampaignType('FIX_APR'), 'UNSUPPORTED');
});

test('resolveCampaignType uses opportunity hint first, then campaign fields', () => {
  assert.equal(
    resolveCampaignType('DUTCH_AUCTION', { distributionType: 'MAX_APR' }),
    'DUTCH_AUCTION'
  );
  assert.equal(
    resolveCampaignType('UNKNOWN', {
      params: {
        distributionMethodParameters: {
          distributionMethod: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE',
        },
      },
    }),
    'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE'
  );
  assert.equal(
    resolveCampaignType('UNKNOWN', {
      params: {
        distributionMethodParameters: {
          distributionMethod: 'FIX_APR',
        },
      },
    }),
    'UNSUPPORTED'
  );
  assert.equal(resolveCampaignType('UNKNOWN', { distributionType: 'MAX_APR' }), 'UNSUPPORTED');
});

test('buildForecastState supports DUTCH_AUCTION without maxAPR cap', () => {
  const state = buildForecastState({
    campaignId: 'dutch-1',
    campaignType: 'DUTCH_AUCTION',
    totalBudget: 1000,
    maxAPR: null,
    startTimestamp: 1_000,
    endTimestamp: 1_000 + 10 * 86400,
    nowTimestamp: 1_000 + 5 * 86400,
    distributedSoFar: 400,
    latestTvl: 2_000_000,
    computedUntil: null,
  });

  assert.equal(state.campaignType, 'DUTCH_AUCTION');
  assert.equal(state.maxAPR, null);
  assert.equal(state.remainingBudget, 600);
  assert.equal(state.remainingDays, 5);
  assert.equal(state.plannedDaily, 100);
  assert.equal(state.requiredDaily, 100);
});

test('buildForecastState requires maxAPR for MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE campaigns', () => {
  assert.throws(
    () =>
      buildForecastState({
        campaignId: 'max-apr-1',
        campaignType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE',
        totalBudget: 1000,
        maxAPR: null,
        startTimestamp: 1_000,
        endTimestamp: 1_000 + 10 * 86400,
        nowTimestamp: 1_000 + 5 * 86400,
        distributedSoFar: 500,
        latestTvl: 1_000_000,
        computedUntil: null,
      }),
    /Missing max APR/
  );
});

test('buildForecastState requires apr input for FIX campaigns and stores it in maxAPR field', () => {
  assert.throws(
    () =>
      buildForecastState({
        campaignId: 'fix-1',
        campaignType: 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE',
        totalBudget: 1000,
        maxAPR: null,
        startTimestamp: 1_000,
        endTimestamp: 1_000 + 10 * 86400,
        nowTimestamp: 1_000 + 5 * 86400,
        distributedSoFar: 300,
        latestTvl: 1_000_000,
        computedUntil: null,
      }),
    /Missing max APR/
  );

  const state = buildForecastState({
    campaignId: 'fix-2',
    campaignType: 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE',
    totalBudget: 1000,
    maxAPR: 0.005,
    startTimestamp: 1_000,
    endTimestamp: 1_000 + 10 * 86400,
    nowTimestamp: 1_000 + 5 * 86400,
    distributedSoFar: 300,
    latestTvl: 1_000_000,
    computedUntil: null,
  });
  assert.equal(state.maxAPR, 0.005);
  assert.equal(state.plannedDaily, 100);
  assert.equal(state.requiredDaily, 140);
});
