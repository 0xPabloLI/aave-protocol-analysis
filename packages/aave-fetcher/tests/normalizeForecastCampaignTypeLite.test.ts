import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeForecastCampaignTypeLite,
} from '../src/merkl-api.js';

const MAX = 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' as const;
const FIX = 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE' as const;
const DUTCH = 'DUTCH_AUCTION' as const;

test('distributionMethod takes highest priority', () => {
  assert.equal(
    normalizeForecastCampaignTypeLite({
      distributionMethod: 'MAX_APR',
      distributionType: 'DUTCH_AUCTION',
      mode: 'FIX_APR',
    }),
    MAX,
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({
      distributionMethod: 'FIX_APR',
      distributionType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE',
    }),
    FIX,
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({
      distributionMethod: 'DUTCH_AUCTION',
      distributionType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE',
    }),
    DUTCH,
  );
});

test('distributionType fallback when no distributionMethod', () => {
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
    MAX,
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE' }),
    FIX,
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT' }),
    FIX,
  );
});

test('AAVE_NET_APR / AAVE_V4_NET_APR / ERC4626_APR map to MAX via distributionType', () => {
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: 'AAVE_NET_APR' }),
    MAX,
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: 'AAVE_V4_NET_APR' }),
    MAX,
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: 'ERC4626_APR' }),
    MAX,
  );
});

test('mode fallback when no distributionMethod or distributionType match', () => {
  assert.equal(
    normalizeForecastCampaignTypeLite({ mode: 'MAX_APR' }),
    MAX,
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ mode: 'FIX_APR' }),
    FIX,
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: 'UNKNOWN_TYPE', mode: 'MAX_APR' }),
    MAX,
  );
});

test('priority: distributionMethod > distributionType > mode', () => {
  assert.equal(
    normalizeForecastCampaignTypeLite({
      distributionMethod: 'FIX_APR',
      distributionType: 'DUTCH_AUCTION',
      mode: 'MAX_APR',
    }),
    FIX,
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({
      distributionType: 'DUTCH_AUCTION',
      mode: 'MAX_APR',
    }),
    DUTCH,
  );
});

test('case-insensitive and whitespace-tolerant', () => {
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionMethod: ' max_apr ' }),
    MAX,
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: ' dutch_auction ' }),
    DUTCH,
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ mode: ' fix_apr ' }),
    FIX,
  );
});

test('null/invalid inputs return null', () => {
  assert.equal(normalizeForecastCampaignTypeLite(null), null);
  assert.equal(normalizeForecastCampaignTypeLite(undefined), null);
  assert.equal(normalizeForecastCampaignTypeLite('string'), null);
  assert.equal(normalizeForecastCampaignTypeLite(42), null);
  assert.equal(normalizeForecastCampaignTypeLite({}), null);
  assert.equal(normalizeForecastCampaignTypeLite({ distributionType: 'UNKNOWN' }), null);
  assert.equal(normalizeForecastCampaignTypeLite({ distributionMethod: 'UNKNOWN' }), null);
  assert.equal(normalizeForecastCampaignTypeLite({ mode: 'UNKNOWN' }), null);
});

test('empty string fields are treated as absent', () => {
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionMethod: '', distributionType: 'DUTCH_AUCTION' }),
    DUTCH,
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: '', mode: 'MAX_APR' }),
    MAX,
  );
});
