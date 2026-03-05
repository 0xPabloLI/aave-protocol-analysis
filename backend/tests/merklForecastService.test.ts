import test from 'node:test';
import assert from 'node:assert/strict';

import { extractNormalizedTotalBudget } from '../src/services/merklForecastService.js';

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
