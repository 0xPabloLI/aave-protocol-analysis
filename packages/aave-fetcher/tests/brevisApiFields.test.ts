import test from 'node:test';
import assert from 'node:assert/strict';

import type { BrevisCampaignItem } from '../src/brevis-api.js';
import { pruneBrevisCampaignForRuntime, extractPositionCapFromDescription } from '../src/brevis-api.js';

test('BrevisCampaignItem API-facing shape omits legacy raw reward field names', () => {
  const item: BrevisCampaignItem = {
    link: 'https://incentra.brevis.network/campaign/',
    name: 'MetaMask Card',
    message: 'Eligible MetaMask Card users',
    breakdowns: [
      {
        campaignApr: 0.024,
        campaignStartedAt: '2025-08-13T13:00:00.000Z',
        campaignEndedAt: '2026-08-08T00:00:00.000Z',
        campaignId: '1754995104',
        totalBudget: 9_998_600,
        latestTvl: 4_151_203.07,
        positionCapUsd: 5000,
      },
    ],
  };
  assert.equal('totalRewardAmount' in item, false);
  assert.equal('totalRewardTokenSymbol' in item, false);
  assert.equal(item.breakdowns[0]?.campaignId, '1754995104');
});

test('pruneBrevisCampaignForRuntime removes transient budget parse fields', () => {
  const withBudget: BrevisCampaignItem = {
    link: 'x',
    breakdowns: [
      {
        campaignApr: 0.01,
        campaignStartedAt: '2020-01-01T00:00:00.000Z',
        campaignEndedAt: '2030-01-01T00:00:00.000Z',
        campaignId: '123',
        budgetNormalizedAmount: 1_000_000,
        rewardTokenSymbol: 'USDC',
        totalBudget: 999,
      },
    ],
  };
  const pruned = pruneBrevisCampaignForRuntime(withBudget);
  assert.equal('budgetNormalizedAmount' in pruned.breakdowns[0]!, false);
  assert.equal(pruned.breakdowns[0]?.rewardTokenSymbol, 'USDC');
  assert.equal(pruned.breakdowns[0]?.totalBudget, 999);
  assert.equal(pruned.link, 'x');
});

test('extractPositionCapFromDescription extracts cap from USDC description', () => {
  assert.equal(extractPositionCapFromDescription('up to 5,000 USDC per user'), 5000);
  assert.equal(extractPositionCapFromDescription('up to 10000 USD per user'), 10000);
  assert.equal(extractPositionCapFromDescription('no cap info here'), null);
  assert.equal(extractPositionCapFromDescription('up to 1,500 USDC'), 1500);
});
