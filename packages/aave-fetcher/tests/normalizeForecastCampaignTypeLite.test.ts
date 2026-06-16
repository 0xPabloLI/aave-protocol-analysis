import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeForecastCampaignTypeLite,
} from '../src/merkl-api.js';

const MAX = 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' as const;
const FIX = 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE' as const;
const DUTCH = 'DUTCH_AUCTION' as const;
const TTA = 'TARGET_TOTAL_APR' as const;
const AMOUNT_PER_VALUE = 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE' as const;
const AMOUNT_PER_AMOUNT = 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT' as const;
const MAX_AMOUNT = 'MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT' as const;

test('Level 2: distributionType exact match', () => {
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' }),
    MAX,
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE' }),
    FIX,
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: 'DUTCH_AUCTION' }),
    DUTCH,
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT' }),
    MAX_AMOUNT,
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE' }),
    AMOUNT_PER_VALUE,
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT' }),
    AMOUNT_PER_AMOUNT,
  );
});

test('Level 2: 7 Target Total APR distributionType values map to TARGET_TOTAL_APR', () => {
  const types = [
    'AAVE_NET_APR',
    'AAVE_V4_NET_APR',
    'ERC4626_APR',
    'ERC4626_SPREAD_CAPPED',
    'ERC4626_TARGET_APR_WITH_MERKL',
    'SOFR_SPREAD_RATCHET',
    'DEEL_DISTRIBUTION',
  ];
  for (const t of types) {
    assert.equal(
      normalizeForecastCampaignTypeLite({ distributionType: t }),
      TTA,
      `distributionType=${t} should map to TARGET_TOTAL_APR`,
    );
  }
});

test('Level 3: targetAPR fallback classifies as TARGET_TOTAL_APR', () => {
  assert.equal(
    normalizeForecastCampaignTypeLite({ targetAPR: 5.0 }),
    TTA,
    'positive number targetAPR should classify as TARGET_TOTAL_APR',
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ targetAPR: '3.5' }),
    TTA,
    'positive string targetAPR should classify as TARGET_TOTAL_APR',
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: 'UNKNOWN_NEW_TYPE', targetAPR: 2.0 }),
    TTA,
    'Level 3 fallback activates when Level 2 misses',
  );
});

test('Level 3: targetAPR fallback does NOT activate for invalid values', () => {
  assert.equal(
    normalizeForecastCampaignTypeLite({ targetAPR: 0 }),
    null,
    'targetAPR=0 should not trigger Level 3',
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ targetAPR: -1 }),
    null,
    'negative targetAPR should not trigger Level 3',
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ targetAPR: NaN }),
    null,
    'NaN targetAPR should not trigger Level 3',
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ targetAPR: 'not a number' }),
    null,
    'non-numeric string targetAPR should not trigger Level 3',
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ targetAPR: undefined }),
    null,
    'undefined targetAPR should not trigger Level 3',
  );
});

test('Level 2 takes priority over Level 3', () => {
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: 'DUTCH_AUCTION', targetAPR: 5.0 }),
    DUTCH,
    'Level 2 match should win over Level 3 fallback',
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE', targetAPR: 5.0 }),
    MAX,
    'Level 2 match should win over Level 3 fallback',
  );
});

test('distributionMethod is no longer used (Level 1 removed)', () => {
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionMethod: 'MAX_APR' } as any),
    null,
    'distributionMethod should be ignored after Level 1 removal',
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionMethod: 'AAVE_NET_APR' } as any),
    null,
    'distributionMethod should be ignored after Level 1 removal',
  );
});

test('case-insensitive and whitespace-tolerant for distributionType', () => {
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: ' dutch_auction ' }),
    DUTCH,
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: ' aave_net_apr ' }),
    TTA,
  );
});

test('null/invalid inputs return null', () => {
  assert.equal(normalizeForecastCampaignTypeLite(null), null);
  assert.equal(normalizeForecastCampaignTypeLite(undefined), null);
  assert.equal(normalizeForecastCampaignTypeLite('string'), null);
  assert.equal(normalizeForecastCampaignTypeLite(42), null);
  assert.equal(normalizeForecastCampaignTypeLite({}), null);
  assert.equal(normalizeForecastCampaignTypeLite({ distributionType: 'UNKNOWN' }), null);
});

test('empty string distributionType is treated as absent', () => {
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: '', targetAPR: 5.0 }),
    TTA,
    'empty distributionType should fall through to Level 3',
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: '' }),
    null,
    'empty distributionType with no targetAPR should return null',
  );
});
