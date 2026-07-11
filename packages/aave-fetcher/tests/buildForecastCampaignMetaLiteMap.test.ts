import test from 'node:test';
import assert from 'node:assert/strict';

import { buildForecastCampaignMetaLiteMap } from '../src/merkl-api.js';

function makeOpp(overrides: Record<string, any> = {}) {
  return {
    chainId: 1,
    tvl: 1000,
    distributionType: undefined as string | undefined,
    rewardsRecord: {
      breakdowns: [],
    },
    campaigns: [],
    ...overrides,
  };
}

function makeBreakdown(campaignId: string, overrides: Record<string, any> = {}) {
  return {
    campaignId,
    distributionType: undefined as string | undefined,
    ...overrides,
  };
}

function makeCampaign(id: string, overrides: Record<string, any> = {}) {
  const { mode, targetAPR, ...rest } = overrides;
  const params: Record<string, any> = {};
  const dmParams: Record<string, any> = {};
  const dsParams: Record<string, any> = {};
  if (mode !== undefined) dsParams.mode = mode;
  if (targetAPR !== undefined) dsParams.targetAPR = targetAPR;
  if (Object.keys(dsParams).length > 0) dmParams.distributionSettings = dsParams;
  if (Object.keys(dmParams).length > 0) params.distributionMethodParameters = dmParams;

  return {
    id,
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...rest,
  };
}

test('rawDistributionType is written from breakdown-level distributionType', () => {
  const result = buildForecastCampaignMetaLiteMap([
    makeOpp({
      rewardsRecord: {
        breakdowns: [
          makeBreakdown('camp-1', { distributionType: 'AAVE_NET_APR' }),
        ],
      },
    }),
  ]);
  assert.equal(result['camp-1']?.rawDistributionType, 'AAVE_NET_APR');
});

test('rawDistributionType falls back to opportunity-level when breakdown has none', () => {
  const result = buildForecastCampaignMetaLiteMap([
    makeOpp({
      distributionType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE',
      rewardsRecord: {
        breakdowns: [makeBreakdown('camp-1')],
      },
    }),
  ]);
  assert.equal(
    result['camp-1']?.rawDistributionType,
    'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE',
  );
});

test('breakdown-level distributionType takes precedence over opportunity-level', () => {
  const result = buildForecastCampaignMetaLiteMap([
    makeOpp({
      distributionType: 'DUTCH_AUCTION',
      rewardsRecord: {
        breakdowns: [
          makeBreakdown('camp-1', { distributionType: 'AAVE_V4_NET_APR' }),
        ],
      },
    }),
  ]);
  assert.equal(result['camp-1']?.rawDistributionType, 'AAVE_V4_NET_APR');
});

test('rawMode is written from campaign params distributionSettings.mode', () => {
  const result = buildForecastCampaignMetaLiteMap([
    makeOpp({
      rewardsRecord: {
        breakdowns: [makeBreakdown('camp-1', { distributionType: 'AAVE_NET_APR' })],
      },
      campaigns: [makeCampaign('camp-1', { mode: 'MAX_APR' })],
    }),
  ]);
  assert.equal(result['camp-1']?.rawMode, 'MAX_APR');
});

test('rawMode is undefined when no mode in campaign params', () => {
  const result = buildForecastCampaignMetaLiteMap([
    makeOpp({
      rewardsRecord: {
        breakdowns: [
          makeBreakdown('camp-1', { distributionType: 'DUTCH_AUCTION' }),
        ],
      },
      campaigns: [makeCampaign('camp-1')],
    }),
  ]);
  assert.equal(result['camp-1']?.rawMode, undefined);
});

test('campaign with unknown distributionType and no targetAPR is skipped (no entry)', () => {
  const result = buildForecastCampaignMetaLiteMap([
    makeOpp({
      rewardsRecord: {
        breakdowns: [
          makeBreakdown('camp-unknown', { distributionType: 'TOTALLY_UNKNOWN' }),
        ],
      },
    }),
  ]);
  assert.equal(result['camp-unknown'], undefined);
});

test('campaign with unknown distributionType but has targetAPR is classified as TARGET_TOTAL_APR via Level 3', () => {
  const result = buildForecastCampaignMetaLiteMap([
    makeOpp({
      rewardsRecord: {
        breakdowns: [
          makeBreakdown('camp-l3', { distributionType: 'SOME_NEW_NET_APR' }),
        ],
      },
      campaigns: [makeCampaign('camp-l3', { targetAPR: 4.7 })],
    }),
  ]);
  assert.equal(result['camp-l3']?.campaignTypeHint, 'TARGET_TOTAL_APR');
  assert.equal(result['camp-l3']?.rawDistributionType, 'SOME_NEW_NET_APR');
});

test('campaign with unknown distributionType and targetAPR=0 is still skipped', () => {
  const result = buildForecastCampaignMetaLiteMap([
    makeOpp({
      rewardsRecord: {
        breakdowns: [
          makeBreakdown('camp-l3-zero', { distributionType: 'SOME_NEW_TYPE' }),
        ],
      },
      campaigns: [makeCampaign('camp-l3-zero', { targetAPR: 0 })],
    }),
  ]);
  assert.equal(result['camp-l3-zero'], undefined);
});

test('ERC4626_APR maps correctly and rawDistributionType is preserved', () => {
  const result = buildForecastCampaignMetaLiteMap([
    makeOpp({
      rewardsRecord: {
        breakdowns: [
          makeBreakdown('camp-erc4626', { distributionType: 'ERC4626_APR' }),
        ],
      },
    }),
  ]);
  assert.equal(result['camp-erc4626']?.rawDistributionType, 'ERC4626_APR');
  assert.equal(
    result['camp-erc4626']?.campaignTypeHint,
    'TARGET_TOTAL_APR',
  );
});

test('duplicate campaignId: first rawDistributionType is kept, second fills if missing', () => {
  const result = buildForecastCampaignMetaLiteMap([
    makeOpp({
      rewardsRecord: {
        breakdowns: [
          makeBreakdown('camp-dup', { distributionType: 'AAVE_NET_APR' }),
          makeBreakdown('camp-dup', { distributionType: 'DUTCH_AUCTION' }),
        ],
      },
    }),
  ]);
  assert.equal(result['camp-dup']?.rawDistributionType, 'AAVE_NET_APR');
});
