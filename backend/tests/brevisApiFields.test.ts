import test from 'node:test';
import assert from 'node:assert/strict';

import type { BrevisCampaignItem, BrevisRewardBudgetHint } from '../../src/brevis-api.ts';

test('BrevisCampaignItem wire shape does not carry raw reward amount inputs', () => {
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
  assert.equal('rewardAddressType' in item, false);
});

test('BrevisRewardBudgetHint holds pricing inputs separate from public campaign', () => {
  const hint: BrevisRewardBudgetHint = {
    normalizedAmount: 10_000_000,
    tokenSymbol: 'USDC',
    rewardAddressType: 'token',
  };
  assert.equal(hint.normalizedAmount, 10_000_000);
  assert.equal(hint.tokenSymbol, 'USDC');
  assert.equal(hint.rewardAddressType, 'token');
});
