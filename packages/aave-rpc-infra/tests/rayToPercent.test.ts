import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rayToPercent } from '../src/index.js';

// ============================================================
// AAV-1106: rayToPercent RAY → percent conversion tests
//
// Bug: was dividing by 10^27 (returning RAY decimal) instead of
// 10^25 (returning percent = RAY decimal × 100).
//
// RAY = 10^27 (Aave's fixed-point format with 27 decimal places).
// A value of 0.055 in RAY = 0.055 × 10^27 = 5.5 × 10^25.
// As a percent, 0.055 decimal = 5.5%.
//
// The function should return 5.5 (percent), NOT 0.055 (RAY decimal).
// ============================================================

test('rayToPercent converts 5.5% RAY to 5.5 percent', () => {
  // 5.5% = 0.055 × 10^27
  const ray = BigInt(55) * 10n ** 24n; // 5.5 × 10^25
  const result = rayToPercent(ray.toString());
  assert.strictEqual(result, 5.5);
});

test('rayToPercent converts 0% RAY to 0 percent', () => {
  assert.strictEqual(rayToPercent('0'), 0);
});

test('rayToPercent converts 100% RAY to 100 percent', () => {
  // 100% = 1.0 × 10^27
  const ray = 10n ** 27n;
  assert.strictEqual(rayToPercent(ray.toString()), 100);
});

test('rayToPercent converts 0.75% RAY to 0.75 percent', () => {
  // 0.75% = 0.0075 × 10^27 = 7.5 × 10^24
  const ray = BigInt(75) * 10n ** 23n;
  assert.strictEqual(rayToPercent(ray.toString()), 0.75);
});

test('rayToPercent converts 35% RAY to 35 percent (slopeAboveOptimal example)', () => {
  // 35% = 0.35 × 10^27 = 3.5 × 10^26
  const ray = BigInt(35) * 10n ** 25n;
  assert.strictEqual(rayToPercent(ray.toString()), 35);
});

test('rayToPercent converts small fractional percent correctly', () => {
  // 0.001% = 0.00001 × 10^27 = 1 × 10^22
  const ray = 10n ** 22n;
  assert.strictEqual(rayToPercent(ray.toString()), 0.001);
});

test('rayToPercent returns undefined for undefined', () => {
  assert.strictEqual(rayToPercent(undefined), undefined);
});

test('rayToPercent returns undefined for null', () => {
  assert.strictEqual(rayToPercent(null), undefined);
});

test('rayToPercent returns undefined for non-numeric string', () => {
  assert.strictEqual(rayToPercent('not-a-number'), undefined);
});

test('rayToPercent accepts BigInt input directly', () => {
  // 5.5% as RAY
  const ray = BigInt(55) * 10n ** 24n;
  assert.strictEqual(rayToPercent(ray), 5.5);
});

test('rayToPercent does NOT return RAY decimal (regression: AAV-1106)', () => {
  // Before fix: 5.5% RAY would incorrectly return 0.055 instead of 5.5
  const ray = BigInt(55) * 10n ** 24n;
  const result = rayToPercent(ray.toString());
  assert.ok(result !== 0.055, `Expected 5.5, got ${result} — RAY decimal bug regression`);
  assert.strictEqual(result, 5.5);
});
