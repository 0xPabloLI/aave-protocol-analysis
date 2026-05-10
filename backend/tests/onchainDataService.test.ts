import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateBaseRateFallback } from '../src/services/onchainDataService.js';

test('calculateBaseRateFallback returns null when borrowApy is missing', () => {
  assert.strictEqual(calculateBaseRateFallback(null, 80, 80, 4, 80), null);
  assert.strictEqual(calculateBaseRateFallback(undefined, 80, 80, 4, 80), null);
});

test('calculateBaseRateFallback returns 0 for zero-rate scenario', () => {
  const result = calculateBaseRateFallback(0, 0, 80, 4, 80);
  assert.strictEqual(result, 0);
});

test('calculateBaseRateFallback util <= optimal with positive optimal', () => {
  const result = calculateBaseRateFallback(0.052, 50, 80, 4, 80);
  assert.ok(Number.isFinite(result!));
  assert.ok(result! >= 0);
});

test('calculateBaseRateFallback util > optimal with slope2', () => {
  const result = calculateBaseRateFallback(0.08, 90, 80, 4, 80);
  assert.ok(Number.isFinite(result!));
  assert.ok(result! >= 0);
});

test('calculateBaseRateFallback returns 0 when optimal is 0 or missing', () => {
  assert.strictEqual(calculateBaseRateFallback(0.05, 80, undefined, 4, 80), 0);
  assert.strictEqual(calculateBaseRateFallback(0.05, 80, 0, 4, 80), 0);
});

test('calculateBaseRateFallback fallback when util > optimal and slope2 missing', () => {
  const result = calculateBaseRateFallback(0.08, 90, 80, 4);
  assert.strictEqual(result, 0);
});

test('calculateBaseRateFallback returns 0 when computed baseRate is negative', () => {
  const result = calculateBaseRateFallback(0.001, 50, 80, 100, 80);
  assert.strictEqual(result, 0);
});