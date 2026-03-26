import test from 'node:test';
import assert from 'node:assert/strict';

import { stripDeprecatedBrevisFields } from '../../src/brevis-api.ts';

test('stripDeprecatedBrevisFields removes deprecated Brevis response fields', () => {
  const result = stripDeprecatedBrevisFields({
    apr: 2.4,
    link: 'https://example.com/brevis',
    startDate: '2025-08-13T13:00:00.000Z',
    endDate: '2026-08-08T00:00:00.000Z',
    name: 'Brevis campaign',
    campaignApr: 2.4,
    campaignStartedAt: '2025-08-13T13:00:00.000Z',
    campaignEndedAt: '2026-08-08T00:00:00.000Z',
    message: 'Aligned message',
    latestTvl: 4_151_203.07,
    totalBudget: 25_000,
    perUserRewardCapUsd: 5000,
    sharedCapGroupId: 'linea-usdc',
    rewardAddressType: 'token',
    totalRewardAmount: 12345,
    totalRewardTokenSymbol: 'USDC',
    description: 'Legacy description',
    tvlUsd: 4_151_203.07,
    totalRewardUsd: 25_000,
  });

  assert.equal(result.campaignApr, 2.4);
  assert.equal(result.message, 'Aligned message');
  assert.equal(result.latestTvl, 4_151_203.07);
  assert.equal(result.totalBudget, 25_000);
  assert.equal(result.perUserRewardCapUsd, 5000);
  assert.equal(result.sharedCapGroupId, 'linea-usdc');
  assert.equal('rewardAddressType' in result, false);
  assert.equal('totalRewardAmount' in result, false);
  assert.equal('totalRewardTokenSymbol' in result, false);
  assert.equal('description' in result, false);
  assert.equal('tvlUsd' in result, false);
  assert.equal('totalRewardUsd' in result, false);
});
