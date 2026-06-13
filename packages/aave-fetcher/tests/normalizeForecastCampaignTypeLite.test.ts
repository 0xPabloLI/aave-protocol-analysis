import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeForecastCampaignTypeLite,
} from '../src/merkl-api.js';

const MAX = 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' as const;
const FIX = 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE' as const;
const DUTCH = 'DUTCH_AUCTION' as const;
const TTA = 'TARGET_TOTAL_APR' as const;

test('distributionMethod takes highest priority', () => {
  assert.equal(
    normalizeForecastCampaignTypeLite({
      distributionMethod: 'MAX_APR',
      distributionType: 'DUTCH_AUCTION',
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

test('7 Target Total APR distributionMethod values map to TARGET_TOTAL_APR via L1', () => {
  const methods = [
    'AAVE_NET_APR',
    'AAVE_V4_NET_APR',
    'ERC4626_APR',
    'ERC4626_SPREAD_CAPPED',
    'ERC4626_TARGET_APR_WITH_MERKL',
    'SOFR_SPREAD_RATCHET',
    'DEEL_DISTRIBUTION',
  ];
  for (const method of methods) {
    assert.equal(
      normalizeForecastCampaignTypeLite({ distributionMethod: method }),
      TTA,
      `distributionMethod=${method} should map to TARGET_TOTAL_APR`,
    );
  }
});

test('7 Target Total APR distributionType values map to TARGET_TOTAL_APR via L2', () => {
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

test('L3 mode mapping has been removed — mode is no longer a type signal', () => {
  assert.equal(
    normalizeForecastCampaignTypeLite({ mode: 'MAX_APR' }),
    null,
    'mode=MAX_APR should no longer resolve via L3',
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ mode: 'FIX_APR' }),
    null,
    'mode=FIX_APR should no longer resolve via L3',
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: 'UNKNOWN_TYPE', mode: 'MAX_APR' }),
    null,
    'mode should not serve as fallback',
  );
});

test('priority: distributionMethod > distributionType', () => {
  assert.equal(
    normalizeForecastCampaignTypeLite({
      distributionMethod: 'FIX_APR',
      distributionType: 'DUTCH_AUCTION',
    }),
    FIX,
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({
      distributionMethod: 'AAVE_NET_APR',
      distributionType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE',
    }),
    TTA,
    'L1 distributionMethod=AAVE_NET_APR overrides L2 distributionType=MAX',
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
    normalizeForecastCampaignTypeLite({ distributionMethod: ' aave_net_apr ' }),
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
  assert.equal(normalizeForecastCampaignTypeLite({ distributionMethod: 'UNKNOWN' }), null);
});

test('empty string fields are treated as absent', () => {
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionMethod: '', distributionType: 'DUTCH_AUCTION' }),
    DUTCH,
  );
  assert.equal(
    normalizeForecastCampaignTypeLite({ distributionType: '', distributionMethod: 'AAVE_NET_APR' }),
    TTA,
  );
});
