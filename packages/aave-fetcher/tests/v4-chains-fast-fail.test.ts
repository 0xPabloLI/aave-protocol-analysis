import test from 'node:test';
import assert from 'node:assert/strict';
import { V4ChainsFetchError } from '../src/v4-errors.js';

test('V4ChainsFetchError is an Error subclass with correct name', () => {
  const err = new V4ChainsFetchError('SDK chains() unreachable');
  assert.ok(err instanceof Error, 'should be instance of Error');
  assert.strictEqual(err.name, 'V4ChainsFetchError');
  assert.strictEqual(err.message, 'SDK chains() unreachable');
});

test('V4ChainsFetchError can be caught by instanceof', () => {
  const err = new V4ChainsFetchError('test');
  let caught = false;
  try {
    throw err;
  } catch (e) {
    if (e instanceof V4ChainsFetchError) {
      caught = true;
    }
  }
  assert.ok(caught, 'V4ChainsFetchError should be catchable via instanceof');
});

test('V4ChainsFetchError is NOT a generic Error instance check confusion', () => {
  const v4Err = new V4ChainsFetchError('chains down');
  const genericErr = new Error('something else');

  // V4ChainsFetchError IS an Error
  assert.ok(v4Err instanceof Error);
  // But a generic Error is NOT a V4ChainsFetchError
  assert.ok(!(genericErr instanceof V4ChainsFetchError));
  // This ensures the catch block can distinguish them
});

// --- fetchV4WithRetry tests ---

import { fetchV4WithRetry } from '../src/v4-retry.js';

function makeV4Reserve(overrides: any = {}): any {
  return {
    reserveId: overrides.reserveId ?? '1:0xspoke:0xtoken:0xhub',
    marketName: 'AaveV4Test',
    chainName: 'Ethereum',
    chainId: 1,
    tokenName: 'Test Token',
    tokenSymbol: 'TEST',
    tokenAddress: '0xtoken',
    aTokenAddress: null,
    vTokenAddress: null,
    ...overrides,
  };
}

test('fetchV4WithRetry: fast-fail on V4ChainsFetchError — no retries, immediate empty', async () => {
  let callCount = 0;
  const fetchFn = async () => {
    callCount++;
    throw new V4ChainsFetchError('SDK chains() unreachable');
  };

  const start = Date.now();
  const result = await fetchV4WithRetry(fetchFn);
  const elapsed = Date.now() - start;

  assert.strictEqual(result.mapped.length, 0);
  assert.strictEqual(result.raw.reserves.length, 0);
  assert.deepStrictEqual(result.spokeHubTopology, []);
  // Should have been called only once (no retries)
  assert.strictEqual(callCount, 1, 'should not retry on V4ChainsFetchError');
  // Should return immediately, not after retry delays (2s+4s+6s = 12s)
  assert.ok(elapsed < 500, `fast-fail should return in <500ms, took ${elapsed}ms`);
});

test('fetchV4WithRetry: generic Error still retries', async () => {
  let callCount = 0;
  const fetchFn = async () => {
    callCount++;
    throw new Error('transient network error');
  };

  const result = await fetchV4WithRetry(fetchFn, { maxRetries: 3 });

  assert.strictEqual(result.mapped.length, 0);
  // Should have retried 3 times
  assert.strictEqual(callCount, 3, 'should retry on generic Error');
});

test('fetchV4WithRetry: success returns data', async () => {
  const reserve = makeV4Reserve();
  const fetchFn = async () => ({
    mapped: [reserve],
    raw: { reserves: [{}] },
    spokeHubTopology: [{ chainId: 1, spokeAddress: '0xspoke', hubAddress: '0xhub' }],
  });

  const result = await fetchV4WithRetry(fetchFn);

  assert.strictEqual(result.mapped.length, 1);
  assert.strictEqual(result.mapped[0].tokenSymbol, 'TEST');
  assert.strictEqual(result.spokeHubTopology.length, 1);
});

test('fetchV4WithRetry: empty result triggers retry', async () => {
  let callCount = 0;
  const fetchFn = async () => {
    callCount++;
    return { mapped: [], raw: { reserves: [] }, spokeHubTopology: [] };
  };

  const result = await fetchV4WithRetry(fetchFn, { maxRetries: 2 });

  assert.strictEqual(result.mapped.length, 0);
  assert.strictEqual(callCount, 2, 'should retry on empty result');
});