import test from 'node:test';
import assert from 'node:assert/strict';

import { toForecastResponseItem } from '../src/controllers/merklForecastController.js';
import type { MerklForecastState } from '../src/services/merklForecastModel.js';

test('toForecastResponseItem returns null for DUTCH_AUCTION', () => {
  const item = toForecastResponseItem({
    campaignId: 'dutch-id',
    campaignType: 'DUTCH_AUCTION',
    totalBudget: 1000,
    plannedDaily: 100,
    requiredDaily: 100,
    aprCap: null,
    remainingBudget: 600,
    remainingDays: 6,
    asOf: Date.now(),
    distributedSoFar: 400,
    latestTvl: 5000,
    startTimestamp: 1,
    endTimestamp: 2,
  } satisfies MerklForecastState);

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
    remainingDays: 7,
    asOf: Date.now(),
    distributedSoFar: 300,
    latestTvl: 5000,
    startTimestamp: 1,
    endTimestamp: 2,
  } satisfies MerklForecastState);

  assert.equal(item!.campaignId, 'fix-id');
  assert.equal('requiredDaily' in item!, false);
  assert.equal(item!.distributedSoFar, 300);
  assert.equal(item!.endTimestamp, 2);
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
    remainingDays: 7,
    asOf: Date.now(),
    distributedSoFar: 300,
    latestTvl: 5000,
    startTimestamp: 1,
    endTimestamp: 2,
  } satisfies MerklForecastState);

  assert.equal(item!.campaignId, 'max-id');
  assert.equal(item!.requiredDaily, 140);
  assert.equal(item!.distributedSoFar, 300);
  assert.equal(item!.endTimestamp, 2);
});

test('toForecastResponseItem omits requiredDaily for TARGET_TOTAL_APR with FIX_APR budgetBoundMode', () => {
  const item = toForecastResponseItem({
    campaignId: 'tta-fix-id',
    campaignType: 'TARGET_TOTAL_APR',
    budgetBoundMode: 'FIX_APR',
    totalBudget: 1000,
    plannedDaily: 100,
    requiredDaily: 140,
    aprCap: 0.047,
    remainingBudget: 700,
    remainingDays: 7,
    asOf: Date.now(),
    distributedSoFar: 300,
    latestTvl: 5000,
    startTimestamp: 1,
    endTimestamp: 2,
  } satisfies MerklForecastState);

  assert.equal(item!.campaignId, 'tta-fix-id');
  assert.equal('requiredDaily' in item!, false);
  assert.equal(item!.distributedSoFar, 300);
});

test('toForecastResponseItem preserves requiredDaily for TARGET_TOTAL_APR with MAX_APR budgetBoundMode', () => {
  const item = toForecastResponseItem({
    campaignId: 'tta-max-id',
    campaignType: 'TARGET_TOTAL_APR',
    budgetBoundMode: 'MAX_APR',
    totalBudget: 1000,
    plannedDaily: 100,
    requiredDaily: 140,
    aprCap: 0.047,
    remainingBudget: 700,
    remainingDays: 7,
    asOf: Date.now(),
    distributedSoFar: 300,
    latestTvl: 5000,
    startTimestamp: 1,
    endTimestamp: 2,
  } satisfies MerklForecastState);

  assert.equal(item!.campaignId, 'tta-max-id');
  assert.equal(item!.requiredDaily, 140);
  assert.equal(item!.distributedSoFar, 300);
});

test('toForecastResponseItem preserves requiredDaily for TARGET_TOTAL_APR without budgetBoundMode (fallback to MAX rules)', () => {
  const item = toForecastResponseItem({
    campaignId: 'tta-no-mode-id',
    campaignType: 'TARGET_TOTAL_APR',
    totalBudget: 1000,
    plannedDaily: 100,
    requiredDaily: 140,
    aprCap: 0.047,
    remainingBudget: 700,
    remainingDays: 7,
    asOf: Date.now(),
    distributedSoFar: 300,
    latestTvl: 5000,
    startTimestamp: 1,
    endTimestamp: 2,
  } satisfies MerklForecastState);

  assert.equal(item!.campaignId, 'tta-no-mode-id');
  assert.equal(item!.requiredDaily, 140);
  assert.equal(item!.distributedSoFar, 300);
});
