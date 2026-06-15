import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeForecastCampaignTypeLite } from '../src/merkl-api.js';
import type { ForecastCampaignTypeLite } from '@internal/aave-shared-contracts';

const AMOUNT_VARIANT_TYPES: Set<ForecastCampaignTypeLite> = new Set([
  'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE',
  'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT',
  'MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT',
]);

function isAmountVariant(type?: ForecastCampaignTypeLite | null): boolean {
  return type ? AMOUNT_VARIANT_TYPES.has(type) : false;
}

test('isAmountVariant: identifies AMOUNT variant distribution types', () => {
  assert.equal(isAmountVariant('FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE'), true);
  assert.equal(isAmountVariant('FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT'), true);
  assert.equal(isAmountVariant('MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT'), true);
});

test('isAmountVariant: VALUE variants are not AMOUNT variants', () => {
  assert.equal(isAmountVariant('FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'), false);
  assert.equal(isAmountVariant('MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE'), false);
});

test('isAmountVariant: non-AMOUNT types are not AMOUNT variants', () => {
  assert.equal(isAmountVariant('DUTCH_AUCTION'), false);
  assert.equal(isAmountVariant('TARGET_TOTAL_APR'), false);
});

test('isAmountVariant: null/undefined returns false', () => {
  assert.equal(isAmountVariant(null), false);
  assert.equal(isAmountVariant(undefined), false);
});

test('normalizeForecastCampaignTypeLite: resolves all AMOUNT variants from distributionType', () => {
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE' }),
    'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE',
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT' }),
    'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT',
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT' }),
    'MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT',
  );
});

test('batch dedup: same token across multiple campaigns resolves once', () => {
  const entries = [
    { campaignId: 'c1', chainId: 1, rewardAddr: '0xaaa', rewardSym: 'TOKEN_A', campaignType: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE' as ForecastCampaignTypeLite },
    { campaignId: 'c2', chainId: 1, rewardAddr: '0xaaa', rewardSym: 'TOKEN_A', campaignType: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE' as ForecastCampaignTypeLite },
    { campaignId: 'c3', chainId: 1, rewardAddr: '0xbbb', rewardSym: 'TOKEN_B', campaignType: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT' as ForecastCampaignTypeLite },
  ];

  type PriceLookupKey = `${number}:${string}:${string}`;
  const tokensToResolve = new Set<PriceLookupKey>();
  for (const entry of entries) {
    tokensToResolve.add(`${entry.chainId}:${entry.rewardAddr}:${entry.rewardSym}` as PriceLookupKey);
  }

  assert.equal(tokensToResolve.size, 2);

  assert.ok(tokensToResolve.has('1:0xaaa:TOKEN_A'));
  assert.ok(tokensToResolve.has('1:0xbbb:TOKEN_B'));
});

test('batch dedup: AMOUNT_PER_AMOUNT entries collect both reward and target tokens', () => {
  const entries = [
    {
      campaignId: 'c1',
      chainId: 1,
      rewardAddr: '0xaaa',
      rewardSym: 'REWARD',
      targetAddr: '0xtarget',
      targetSym: 'TARGET',
      campaignType: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT' as ForecastCampaignTypeLite,
    },
  ];

  type PriceLookupKey = `${number}:${string}:${string}`;
  const tokensToResolve = new Set<PriceLookupKey>();
  for (const entry of entries) {
    tokensToResolve.add(`${entry.chainId}:${entry.rewardAddr}:${entry.rewardSym}` as PriceLookupKey);
    if (entry.campaignType === 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT'
      || entry.campaignType === 'MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT') {
      tokensToResolve.add(`${entry.chainId}:${entry.targetAddr}:${entry.targetSym}` as PriceLookupKey);
    }
  }

  assert.equal(tokensToResolve.size, 2);
  assert.ok(tokensToResolve.has('1:0xaaa:REWARD'));
  assert.ok(tokensToResolve.has('1:0xtarget:TARGET'));
});

test('batch dedup: preResolvedPrices Map lookup by campaignId', () => {
  type PriceLookupKey = `${number}:${string}:${string}`;
  const preResolvedPrices = new Map<PriceLookupKey, number | undefined>();
  preResolvedPrices.set('1:0xaaa:TOKEN_A', 1.5);
  preResolvedPrices.set('1:0xbbb:TOKEN_B', 2.0);

  const amountVariantPriceMap = new Map<string, { rewardTokenPrice?: number; targetTokenPrice?: number }>();

  const entries = [
    { campaignId: 'c1', chainId: 1, rewardAddr: '0xaaa', rewardSym: 'TOKEN_A', campaignType: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE' as ForecastCampaignTypeLite },
    { campaignId: 'c2', chainId: 1, rewardAddr: '0xaaa', rewardSym: 'TOKEN_A', campaignType: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE' as ForecastCampaignTypeLite },
  ];

  for (const entry of entries) {
    const rewardKey = `${entry.chainId}:${entry.rewardAddr}:${entry.rewardSym}` as PriceLookupKey;
    const rewardTokenPrice = preResolvedPrices.get(rewardKey);
    amountVariantPriceMap.set(entry.campaignId, { rewardTokenPrice });
  }

  assert.equal(amountVariantPriceMap.get('c1')?.rewardTokenPrice, 1.5);
  assert.equal(amountVariantPriceMap.get('c2')?.rewardTokenPrice, 1.5);
});
