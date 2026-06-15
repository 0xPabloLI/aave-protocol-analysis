import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveCampaignApr } from '../src/merkl-api.js';

test('VALUE variant: no distributionType, campaign.apr > 0 returns percentage / 100', () => {
  const r = resolveCampaignApr({ apr: 3.5 });
  assert.equal(r.apr, 0.035);
  assert.equal(r.unavailableReason, undefined);
  assert.equal(resolveCampaignApr({ apr: 6 }).apr, 0.06);
  assert.equal(resolveCampaignApr({ apr: 0.5 }).apr, 0.005);
});

test('VALUE variant: distributionType without _AMOUNT_, campaign.apr > 0 returns percentage / 100', () => {
  const r1 = resolveCampaignApr({ apr: 3.5 }, 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE');
  assert.equal(r1.apr, 0.035);
  assert.equal(r1.unavailableReason, undefined);
  const r2 = resolveCampaignApr({ apr: 6 }, 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE');
  assert.equal(r2.apr, 0.06);
});

test('AMOUNT_PER_VALUE: with rewardTokenPrice computes USD APR', () => {
  const r = resolveCampaignApr(
    { apr: 0, distributionSettings: { apr: 18.25 } },
    'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE',
    0.001,
  );
  assert.equal(r.apr, 0.01825);
  assert.equal(r.unavailableReason, undefined);
});

test('AMOUNT_PER_VALUE: without rewardTokenPrice returns 0 + NO_REWARD_TOKEN_PRICE', () => {
  const r = resolveCampaignApr(
    { apr: 0, distributionSettings: { apr: 18.25 } },
    'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE',
  );
  assert.equal(r.apr, 0);
  assert.equal(r.unavailableReason, 'NO_REWARD_TOKEN_PRICE');
});

test('AMOUNT_PER_VALUE: rewardTokenPrice = 0 returns 0 + NO_REWARD_TOKEN_PRICE', () => {
  const r = resolveCampaignApr(
    { apr: 0, distributionSettings: { apr: 18.25 } },
    'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE',
    0,
  );
  assert.equal(r.apr, 0);
  assert.equal(r.unavailableReason, 'NO_REWARD_TOKEN_PRICE');
});

test('AMOUNT_PER_AMOUNT: with both token prices computes USD APR', () => {
  const r = resolveCampaignApr(
    { apr: 0, distributionSettings: { apr: 3650 } },
    'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT',
    0.001,
    3000,
  );
  assert.equal(r.apr, 3650 * 0.001 / 3000);
  assert.equal(r.unavailableReason, undefined);
});

test('AMOUNT_PER_AMOUNT: missing rewardTokenPrice returns 0 + NO_REWARD_TOKEN_PRICE', () => {
  const r = resolveCampaignApr(
    { apr: 0, distributionSettings: { apr: 3650 } },
    'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT',
    undefined,
    3000,
  );
  assert.equal(r.apr, 0);
  assert.equal(r.unavailableReason, 'NO_REWARD_TOKEN_PRICE');
});

test('AMOUNT_PER_AMOUNT: missing targetTokenPrice returns 0 + NO_TARGET_TOKEN_PRICE', () => {
  const r = resolveCampaignApr(
    { apr: 0, distributionSettings: { apr: 3650 } },
    'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT',
    0.001,
    undefined,
  );
  assert.equal(r.apr, 0);
  assert.equal(r.unavailableReason, 'NO_TARGET_TOKEN_PRICE');
});

test('AMOUNT variant: nested distributionSettings path', () => {
  const r1 = resolveCampaignApr(
    { apr: 0, params: { distributionMethodParameters: { distributionSettings: { apr: 18.25 } } } },
    'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE',
    0.001,
  );
  assert.equal(r1.apr, 0.01825);

  const r2 = resolveCampaignApr(
    { apr: 0, distributionMethodParameters: { distributionSettings: { apr: 18.25 } } },
    'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE',
    0.001,
  );
  assert.equal(r2.apr, 0.01825);
});

test('AMOUNT variant without distributionSettings.apr returns 0 without unavailable reason', () => {
  const r = resolveCampaignApr({ apr: 3.5 }, 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE');
  assert.equal(r.apr, 0);
  assert.equal(r.unavailableReason, undefined);
});

test('VALUE variant: campaign.apr > 0 ignores distributionSettings.apr', () => {
  const r = resolveCampaignApr(
    { apr: 3.5, distributionSettings: { apr: 0.035 } },
    'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE',
  );
  assert.equal(r.apr, 0.035);
  assert.equal(r.unavailableReason, undefined);
});

test('DUTCH_AUCTION and TARGET_TOTAL_APR are not AMOUNT variants', () => {
  const r1 = resolveCampaignApr({ apr: 3.5 }, 'DUTCH_AUCTION');
  assert.equal(r1.apr, 0.035);
  assert.equal(r1.unavailableReason, undefined);

  const r2 = resolveCampaignApr({ apr: 3.5 }, 'AAVE_NET_APR');
  assert.equal(r2.apr, 0.035);
  assert.equal(r2.unavailableReason, undefined);
});

test('both zero returns 0', () => {
  assert.equal(resolveCampaignApr({ apr: 0 }).apr, 0);
  assert.equal(resolveCampaignApr({ apr: 0 }, 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE').apr, 0);
  assert.equal(
    resolveCampaignApr({ apr: 0, distributionSettings: { apr: 0 } }, 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE').apr,
    0,
  );
  assert.equal(resolveCampaignApr({}).apr, 0);
  assert.equal(resolveCampaignApr(null).apr, 0);
  assert.equal(resolveCampaignApr(undefined).apr, 0);
});
