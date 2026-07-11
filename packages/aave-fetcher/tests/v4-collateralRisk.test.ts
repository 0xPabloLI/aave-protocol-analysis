import test from 'node:test';
import assert from 'node:assert/strict';

import { percentValueToPercent } from '../src/utils/number.js';

test('percentValueToPercent converts V4 PercentNumber collateralRisk (zero)', () => {
  const sdk = { __typename: 'PercentNumber', onChainValue: '0', decimals: 4, value: '0', normalized: '0' };
  assert.equal(percentValueToPercent(sdk), 0);
});

test('percentValueToPercent converts V4 PercentNumber collateralRisk (5%)', () => {
  const sdk = { __typename: 'PercentNumber', onChainValue: '500', decimals: 4, value: '0.05', normalized: '5' };
  assert.equal(percentValueToPercent(sdk), 5);
});

test('percentValueToPercent converts V4 PercentNumber collateralRisk (76%)', () => {
  const sdk = { __typename: 'PercentNumber', onChainValue: '7600', decimals: 4, value: '0.76', normalized: '76' };
  assert.equal(percentValueToPercent(sdk), 76);
});

test('percentValueToPercent returns undefined for undefined input (V3 reserve)', () => {
  assert.equal(percentValueToPercent(undefined), undefined);
});

test('percentValueToPercent returns undefined for null-ish value', () => {
  const sdk = { __typename: 'PercentNumber', onChainValue: '0', decimals: 4, value: undefined, normalized: '0' };
  assert.equal(percentValueToPercent(sdk), undefined);
});
