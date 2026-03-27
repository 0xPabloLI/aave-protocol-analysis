import test from 'node:test';
import assert from 'node:assert/strict';

import type { BrevisCampaignItem } from '../../src/brevis-api.ts';
import { pruneBrevisCampaignForRuntime } from '../../src/brevis-api.ts';

test('BrevisCampaignItem API-facing shape omits legacy raw reward field names', () => {
  const item: BrevisCampaignItem = {
    link: 'https://incentra.brevis.network/campaign/',
    campaignApr: 2.4,
    campaignStartedAt: '2025-08-13T13:00:00.000Z',
    campaignEndedAt: '2026-08-08T00:00:00.000Z',
    campaignId: '1754995104',
    totalBudget: 9_998_600,
    latestTvl: 4_151_203.07,
    message: 'Eligible MetaMask Card users',
    perUserRewardCapUsd: 5000,
  };
  assert.equal('totalRewardAmount' in item, false);
  assert.equal('totalRewardTokenSymbol' in item, false);
});

test('pruneBrevisCampaignForRuntime removes transient budget parse fields', () => {
  const withBudget: BrevisCampaignItem = {
    link: 'x',
    campaignApr: 1,
    campaignStartedAt: '2020-01-01T00:00:00.000Z',
    campaignEndedAt: '2030-01-01T00:00:00.000Z',
    budgetNormalizedAmount: 1_000_000,
    budgetTokenSymbol: 'USDC',
    totalBudget: 999,
  };
  const pruned = pruneBrevisCampaignForRuntime(withBudget);
  assert.equal('budgetNormalizedAmount' in pruned, false);
  assert.equal('budgetTokenSymbol' in pruned, false);
  assert.equal(pruned.totalBudget, 999);
  assert.equal(pruned.link, 'x');
});
