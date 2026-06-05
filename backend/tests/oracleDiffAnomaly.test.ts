import test from 'node:test';
import assert from 'node:assert/strict';

test('oracle diff: diff > threshold triggers anomaly', () => {
  const sdkPrice = 100;
  const oraclePrice = 102;
  const threshold = 0.01;
  const diff = Math.abs(oraclePrice - sdkPrice) / sdkPrice;
  assert.ok(diff > threshold);
  assert.equal(+(diff * 100).toFixed(2), 2);
});

test('oracle diff: diff <= threshold does not trigger anomaly', () => {
  const sdkPrice = 100;
  const oraclePrice = 100.5;
  const threshold = 0.01;
  const diff = Math.abs(oraclePrice - sdkPrice) / sdkPrice;
  assert.ok(diff <= threshold);
});

test('oracle diff: diffPct is number not string', () => {
  const sdkPrice = 100;
  const oraclePrice = 105;
  const diff = Math.abs(oraclePrice - sdkPrice) / sdkPrice;
  const diffPct = +(diff * 100).toFixed(2);
  assert.equal(typeof diffPct, 'number');
  assert.equal(diffPct, 5);
});

test('oracle diff: diffPct preserves 2 decimal places', () => {
  const sdkPrice = 1000;
  const oraclePrice = 1015;
  const diff = Math.abs(oraclePrice - sdkPrice) / sdkPrice;
  const diffPct = +(diff * 100).toFixed(2);
  assert.equal(diffPct, 1.5);
});

test('oracle diff: exact threshold boundary does not trigger', () => {
  const sdkPrice = 100;
  const oraclePrice = 101;
  const threshold = 0.01;
  const diff = Math.abs(oraclePrice - sdkPrice) / sdkPrice;
  assert.ok(diff === threshold);
  assert.ok(!(diff > threshold));
});
