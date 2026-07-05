import test from 'node:test';
import assert from 'node:assert/strict';

import { extractPositionCapFromCampaign } from '../src/merkl-api.js';

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

test('extracts positionCap with targetToken.decimals and explicit price', () => {
  const result = extractPositionCapFromCampaign(
    {
      params: {
        computeScoreParameters: {
          computeMethod: 'maxDeposit',
          computeSettings: { maxDeposit: '1000000000' },
        },
      },
      targetToken: { decimals: 6 },
    },
    1,
  );
  assert.equal(result.positionCap, 1000);
  assert.equal(result.isCombineCap, false);
});

test('extracts positionCap with fallback to campaign.targetToken.price', () => {
  const result = extractPositionCapFromCampaign({
    params: {
      computeScoreParameters: {
        computeMethod: 'maxDeposit',
        computeSettings: { maxDeposit: '2000000000000000000' },
      },
    },
    targetToken: { decimals: 18, price: 2.5 },
  });
  assert.equal(result.positionCap, 5);
  assert.equal(result.isCombineCap, false);
});

test('extracts positionCap with fallback decimals 18', () => {
  const result = extractPositionCapFromCampaign(
    {
      params: {
        computeScoreParameters: {
          computeMethod: 'maxDeposit',
          computeSettings: { maxDeposit: '1000000000000000000' },
        },
      },
    },
    3,
  );
  assert.equal(result.positionCap, 3);
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
      targetToken: { decimals: 18 },
    },
    1,
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
      targetToken: { decimals: 6 },
    },
    1,
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
      targetToken: { decimals: 6 },
    },
    1,
  );
  assert.equal(result.positionCap, 500);
  assert.equal(result.isCombineCap, false);
});
