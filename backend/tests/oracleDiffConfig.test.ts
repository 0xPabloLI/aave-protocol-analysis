import test from 'node:test';
import assert from 'node:assert/strict';
import { oracleDiffConfig } from '../src/config.js';

test('oracleDiffConfig.threshold defaults to 0.01 when ORACLE_DIFF_THRESHOLD not set', () => {
  assert.equal(oracleDiffConfig.threshold, 0.01);
});

test('oracleDiffConfig.threshold is a positive number', () => {
  assert.ok(typeof oracleDiffConfig.threshold === 'number');
  assert.ok(oracleDiffConfig.threshold >= 0);
});
