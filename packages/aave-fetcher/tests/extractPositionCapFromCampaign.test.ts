import test from 'node:test';
import assert from 'node:assert/strict';

import { extractPositionCapFromCampaign, buildReserveUnderlyingLookup } from '../src/merkl-api.js';

test('returns empty when computeMethod is not maxDeposit', () => {
  const result = extractPositionCapFromCampaign({
    params: { computeScoreParameters: { computeMethod: 'genericTimeWeighted' } },
  }, 1, 18);
  assert.deepStrictEqual(result, {});
});

test('returns empty when computeMethod is missing', () => {
  const result = extractPositionCapFromCampaign({}, 1, 18);
  assert.deepStrictEqual(result, {});
});

test('returns empty when maxDeposit is missing', () => {
  const result = extractPositionCapFromCampaign({
    params: { computeScoreParameters: { computeMethod: 'maxDeposit', computeSettings: {} } },
  }, 1, 18);
  assert.deepStrictEqual(result, {});
});

test('extracts positionCap with explicit price and decimals (USDT: 6 decimals, 1000 USDT)', () => {
  const result = extractPositionCapFromCampaign(
    {
      params: {
        computeScoreParameters: {
          computeMethod: 'maxDeposit',
          computeSettings: { maxDeposit: '1000000000' },
        },
      },
    },
    1,
    6,
  );
  assert.equal(result.positionCap, 1000);
  assert.equal(result.isCombineCap, false);
});

test('extracts positionCap with WETH: 18 decimals, 20.15 WETH, price=1765', () => {
  const result = extractPositionCapFromCampaign(
    {
      params: {
        computeScoreParameters: {
          computeMethod: 'maxDeposit',
          computeSettings: { maxDeposit: '20150000000000000000' },
        },
      },
    },
    1765,
    18,
  );
  assert.equal(result.positionCap, 20.15 * 1765);
  assert.equal(result.isCombineCap, false);
});

test('extracts positionCap for DUTCH_AUCTION + maxDeposit (Celo USDT scenario)', () => {
  const result = extractPositionCapFromCampaign(
    {
      distributionType: 'DUTCH_AUCTION',
      type: 'AAVE_NET_LENDING',
      params: {
        computeScoreParameters: {
          computeMethod: 'maxDeposit',
          computeSettings: { maxDeposit: '1000000000' },
        },
      },
    },
    0.999,
    6,
  );
  assert.equal(result.positionCap, 999);
  assert.equal(result.isCombineCap, false);
});

test('returns empty when nativeAmount is zero', () => {
  const result = extractPositionCapFromCampaign(
    {
      params: {
        computeScoreParameters: {
          computeMethod: 'maxDeposit',
          computeSettings: { maxDeposit: '0' },
        },
      },
    },
    1,
    18,
  );
  assert.deepStrictEqual(result, {});
});

test('returns empty when maxDeposit is negative', () => {
  const result = extractPositionCapFromCampaign(
    {
      params: {
        computeScoreParameters: {
          computeMethod: 'maxDeposit',
          computeSettings: { maxDeposit: '-1000000' },
        },
      },
    },
    1,
    6,
  );
  assert.deepStrictEqual(result, {});
});

test('always sets isCombineCap to false for Merkl', () => {
  const result = extractPositionCapFromCampaign(
    {
      params: {
        computeScoreParameters: {
          computeMethod: 'maxDeposit',
          computeSettings: { maxDeposit: '500000000' },
        },
      },
    },
    1,
    6,
  );
  assert.equal(result.positionCap, 500);
  assert.equal(result.isCombineCap, false);
});

test('buildReserveUnderlyingLookup maps aTokenAddress and tokenAddress to reserve info', () => {
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
  assert.equal(lookup.get(aTokenKey)!.price, 0.999);
  assert.equal(lookup.get(aTokenKey)!.decimals, 6);
});

test('buildReserveUnderlyingLookup skips reserves with missing price but defaults decimals to 18', () => {
  const lookup = buildReserveUnderlyingLookup([
    { chainId: 1, tokenAddress: '0xa', aTokenAddress: '0xb', tokenPrice: undefined, decimals: 6 } as any,
    { chainId: 1, tokenAddress: '0xc', aTokenAddress: '0xd', tokenPrice: 1, decimals: undefined } as any,
    { chainId: 1, tokenAddress: '0xe', aTokenAddress: '0xf', tokenPrice: -1, decimals: 6 } as any,
  ]);
  assert.equal(lookup.size, 2);
  assert.equal(lookup.get('1:0xd')!.decimals, 18);
  assert.equal(lookup.get('1:0xc')!.decimals, 18);
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
  assert.equal(lookup.get(underlyingKey)!.price, 1.5);
});
