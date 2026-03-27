import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractDailyRewardsRecords,
  extractNormalizedTotalBudget,
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
