import test from 'node:test';
import assert from 'node:assert/strict';

import { extractPositionCapFromCampaign, buildReserveUnderlyingLookup } from '../src/merkl-api.js';

test('returns empty when computeMethod is not maxDeposit', () => {
  const result = extractPositionCapFromCampaign({
    params: { computeScoreParameters: { computeMethod: 'genericTimeWeighted' } },
  });
  assert.deepStrictEqual(result, {});
});

test('returns empty when computeMethod is missing', () => {
  const result = extractPositionCapFromCampaign({});
  assert.deepStrictEqual(result, {});
});

test('returns empty when maxDeposit is missing', () => {
  const result = extractPositionCapFromCampaign({
    params: { computeScoreParameters: { computeMethod: 'maxDeposit', computeSettings: {} } },
  });
  assert.deepStrictEqual(result, {});
});

test('extracts positionCapNative as raw string (USDT: 6 decimals)', () => {
  const result = extractPositionCapFromCampaign({
    params: {
      computeScoreParameters: {
        computeMethod: 'maxDeposit',
        computeSettings: { maxDeposit: '1000000000' },
      },
    },
  });
  assert.equal(result.positionCapNative, '1000000000');
  assert.equal(result.isCombineCap, false);
});

test('extracts positionCapNative as raw string (WETH: 18 decimals)', () => {
  const result = extractPositionCapFromCampaign({
    params: {
      computeScoreParameters: {
        computeMethod: 'maxDeposit',
        computeSettings: { maxDeposit: '20150000000000000000' },
      },
    },
  });
  assert.equal(result.positionCapNative, '20150000000000000000');
  assert.equal(result.isCombineCap, false);
});

test('extracts positionCapNative for DUTCH_AUCTION + maxDeposit', () => {
  const result = extractPositionCapFromCampaign({
    distributionType: 'DUTCH_AUCTION',
    type: 'AAVE_NET_LENDING',
    params: {
      computeScoreParameters: {
        computeMethod: 'maxDeposit',
        computeSettings: { maxDeposit: '1000000000' },
      },
    },
  });
  assert.equal(result.positionCapNative, '1000000000');
  assert.equal(result.isCombineCap, false);
});

test('returns empty when maxDeposit is zero', () => {
  const result = extractPositionCapFromCampaign({
    params: {
      computeScoreParameters: {
        computeMethod: 'maxDeposit',
        computeSettings: { maxDeposit: '0' },
      },
    },
  });
  assert.deepStrictEqual(result, {});
});

test('returns empty when maxDeposit is negative', () => {
  const result = extractPositionCapFromCampaign({
    params: {
      computeScoreParameters: {
        computeMethod: 'maxDeposit',
        computeSettings: { maxDeposit: '-1000000' },
      },
    },
  });
  assert.deepStrictEqual(result, {});
});

test('always sets isCombineCap to false for Merkl', () => {
  const result = extractPositionCapFromCampaign({
    params: {
      computeScoreParameters: {
        computeMethod: 'maxDeposit',
        computeSettings: { maxDeposit: '500000000' },
      },
    },
  });
  assert.equal(result.positionCapNative, '500000000');
  assert.equal(result.isCombineCap, false);
});

test('buildReserveUnderlyingLookup returns Set of chainId:address keys', () => {
  const lookup = buildReserveUnderlyingLookup([
    {
      chainId: 42220,
      tokenAddress: '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e',
      aTokenAddress: '0xdee98402a302e4d707fb9bf2bac66faeec31e8df',
      tokenPrice: 0.999,
      decimals: 6,
    } as any,
  ]);
  const aTokenKey = '42220:0xdee98402a302e4d707fb9bf2bac66faeec31e8df';
  const underlyingKey = '42220:0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e';
  assert.ok(lookup.has(aTokenKey), 'aTokenAddress key exists');
  assert.ok(lookup.has(underlyingKey), 'tokenAddress key exists');
});

test('buildReserveUnderlyingLookup includes reserves even without price/decimals', () => {
  const lookup = buildReserveUnderlyingLookup([
    { chainId: 1, tokenAddress: '0xa', aTokenAddress: '0xb', tokenPrice: undefined, decimals: 6 } as any,
    { chainId: 1, tokenAddress: '0xc', aTokenAddress: '0xd', tokenPrice: 1, decimals: undefined } as any,
    { chainId: 1, tokenAddress: '0xe', aTokenAddress: '0xf', tokenPrice: -1, decimals: 6 } as any,
  ]);
  assert.equal(lookup.size, 6);
  assert.ok(lookup.has('1:0xa'));
  assert.ok(lookup.has('1:0xb'));
  assert.ok(lookup.has('1:0xc'));
  assert.ok(lookup.has('1:0xd'));
  assert.ok(lookup.has('1:0xe'));
  assert.ok(lookup.has('1:0xf'));
});

test('buildReserveUnderlyingLookup handles V4 reserve without aTokenAddress', () => {
  const lookup = buildReserveUnderlyingLookup([
    {
      chainId: 1,
      tokenAddress: '0xunderlying',
      aTokenAddress: null,
      tokenPrice: 1.5,
      decimals: 18,
    } as any,
  ]);
  assert.ok(!lookup.has('1:null'), 'null aTokenAddress should not be added as key');
  const underlyingKey = '1:0xunderlying';
  assert.ok(lookup.has(underlyingKey), 'tokenAddress key exists for V4');
});
