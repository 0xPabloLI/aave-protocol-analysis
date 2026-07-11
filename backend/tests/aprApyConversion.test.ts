import test from 'node:test';
import assert from 'node:assert/strict';
import {
  convertAprToApy,
  apyToApr,
  computeTargetTotalAprIncentiveApr,
} from '../src/lib/aprApyConversion.js';

test('convertAprToApy: 0% APR → 0% APY', () => {
  assert.equal(convertAprToApy(0), 0);
});

test('convertAprToApy: positive APR to APY (monthly compounding)', () => {
  const apr = 12;
  const apy = convertAprToApy(apr);
  assert.ok(apy > apr, 'APY > APR for positive rates');
  assert.ok(Math.abs(apy - 12.682503) < 0.01, `Expected ~12.68, got ${apy}`);
});

test('convertAprToApy: small rate', () => {
  const apr = 4.7;
  const apy = convertAprToApy(apr);
  assert.ok(apy > apr);
  assert.ok(Math.abs(apy - 4.8088) < 0.01, `Expected ~4.81, got ${apy}`);
});

test('apyToApr: round-trip with convertAprToApy', () => {
  const originalApr = 5.83;
  const apy = convertAprToApy(originalApr);
  const backToApr = apyToApr(apy);
  assert.ok(Math.abs(backToApr - originalApr) < 0.0001, `Round-trip failed: ${backToApr} != ${originalApr}`);
});

test('apyToApr: 0% APY → 0% APR', () => {
  assert.equal(apyToApr(0), 0);
});

test('convertAprToApy: negative APR', () => {
  const apr = -5;
  const apy = convertAprToApy(apr);
  assert.ok(apy > apr, 'APY less negative than APR for negative rates');
});

test('computeTargetTotalAprIncentiveApr: supply side — targetAPR > nativeAPY', () => {
  const targetApr = 4.7;
  const nativeApy = 2.0;
  const incentiveApr = computeTargetTotalAprIncentiveApr(targetApr, nativeApy, 'supply');
  assert.ok(incentiveApr > 0, 'Incentive APR should be positive');
  assert.ok(incentiveApr < targetApr, 'Incentive APR should be less than targetAPR');
});

test('computeTargetTotalAprIncentiveApr: supply side — targetAPR < nativeAPY → 0', () => {
  const targetApr = 2.0;
  const nativeApy = 4.7;
  const incentiveApr = computeTargetTotalAprIncentiveApr(targetApr, nativeApy, 'supply');
  assert.equal(incentiveApr, 0, 'Incentive APR should be 0 when native already exceeds target');
});

test('computeTargetTotalAprIncentiveApr: borrow side — targetAPR < nativeAPY', () => {
  const targetApr = 2.0;
  const nativeApy = 5.0;
  const incentiveApr = computeTargetTotalAprIncentiveApr(targetApr, nativeApy, 'borrow');
  assert.ok(incentiveApr > 0, 'Borrow incentive APR should be positive');
});

test('computeTargetTotalAprIncentiveApr: borrow side — targetAPR > nativeAPY → 0', () => {
  const targetApr = 5.0;
  const nativeApy = 2.0;
  const incentiveApr = computeTargetTotalAprIncentiveApr(targetApr, nativeApy, 'borrow');
  assert.equal(incentiveApr, 0, 'Borrow incentive APR should be 0 when borrow rate already below target');
});

test('computeTargetTotalAprIncentiveApr: matches Aave interface reference calculation', () => {
  const targetApr = 7.7;
  const nativeApy = 3.5;
  const targetApy = convertAprToApy(targetApr);
  const expectedApy = targetApy - nativeApy;
  const expectedApr = apyToApr(expectedApy);
  const result = computeTargetTotalAprIncentiveApr(targetApr, nativeApy, 'supply');
  assert.ok(Math.abs(result - expectedApr) < 0.0001, `Expected ${expectedApr}, got ${result}`);
});
