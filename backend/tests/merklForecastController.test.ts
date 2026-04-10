import test from 'node:test';
import assert from 'node:assert/strict';

import { toForecastResponseItem } from '../src/controllers/merklForecastController.js';

test('toForecastResponseItem returns null for DUTCH_AUCTION', () => {
  const item = toForecastResponseItem({
    campaignId: 'dutch-id',
    campaignType: 'DUTCH_AUCTION',
    totalBudget: 1000,
    plannedDaily: 100,
    requiredDaily: 100,
    aprCap: null,
    remainingBudget: 600,
    distributedSoFar: 400,
    latestTvl: 5000,
    startTimestamp: 1,
    endTimestamp: 2,
  });

  assert.equal(item, null);
});

test('toForecastResponseItem omits requiredDaily for FIX_REWARD campaigns', () => {
  const item = toForecastResponseItem({
    campaignId: 'fix-id',
    campaignType: 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE',
    totalBudget: 1000,
    plannedDaily: 100,
    requiredDaily: 140,
    aprCap: 0.05,
    remainingBudget: 700,
    distributedSoFar: 300,
    latestTvl: 5000,
    startTimestamp: 1,
    endTimestamp: 2,
  });

  assert.equal(item.campaignId, 'fix-id');
  assert.equal('requiredDaily' in item, false);
  assert.equal(item.distributedSoFar, 300);
  assert.equal(item.endTimestamp, 2);
});

test('toForecastResponseItem preserves requiredDaily for MAX_REWARD campaigns', () => {
  const item = toForecastResponseItem({
    campaignId: 'max-id',
    campaignType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE',
    totalBudget: 1000,
    plannedDaily: 100,
    requiredDaily: 140,
    aprCap: 0.05,
    remainingBudget: 700,
    distributedSoFar: 300,
    latestTvl: 5000,
    startTimestamp: 1,
    endTimestamp: 2,
  });

  assert.equal(item.campaignId, 'max-id');
  assert.equal(item.requiredDaily, 140);
  assert.equal(item.distributedSoFar, 300);
  assert.equal(item.endTimestamp, 2);
});
