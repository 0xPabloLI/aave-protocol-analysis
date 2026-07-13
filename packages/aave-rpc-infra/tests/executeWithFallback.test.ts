import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderPool } from '../src/index.js';
import type { ErrorClassifier } from '../src/index.js';

test('executeWithFallback: primary succeeds → returns result, reports success, never calls fallback', () => {
  const pool = new ProviderPool();
  const urls = ['https://rpc-a.example'];
  let fallbackCalled = false;

  const result = pool.executeWithFallback(
    1,
    urls,
    {
      primary: async (_p) => 'primary-result',
      fallback: async (_p) => { fallbackCalled = true; return 'fallback-result'; },
    },
  );

  result.then((val) => {
    assert.equal(val, 'primary-result');
    assert.equal(fallbackCalled, false);

    const status = pool.getHealthStatus();
    assert.equal(status.summary.suppressed, 0, 'no suppressed endpoints after success');
  });

  return result;
});

test('executeWithFallback: contract error + fallback fails → moves to next RPC', () => {
  const pool = new ProviderPool();
  const urls = ['https://rpc-a.example', 'https://rpc-b.example'];
  let primaryCallCount = 0;
  let fallbackCallCount = 0;

  const result = pool.executeWithFallback(
    1,
    urls,
    {
      primary: async (_p) => {
        primaryCallCount++;
        const err = new Error('CALL_EXCEPTION');
        (err as any).code = 'CALL_EXCEPTION';
        throw err;
      },
      fallback: async (_p) => {
        fallbackCallCount++;
        const err = new Error('fallback failed');
        (err as any).code = 'CALL_EXCEPTION';
        throw err;
      },
    },
  );

  return result.then(
    () => assert.fail('should have thrown'),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('all 2 RPCs failed'));
      assert.equal(primaryCallCount, 2);
      assert.equal(fallbackCallCount, 2, 'fallback tried on each RPC but failed');
    },
  );
});

test('executeWithFallback: all RPCs exhausted with network errors → throws', () => {
  const pool = new ProviderPool();
  const urls = ['https://rpc-a.example', 'https://rpc-b.example'];
  let primaryCallCount = 0;

  const result = pool.executeWithFallback(
    1,
    urls,
    {
      primary: async (_p) => {
        primaryCallCount++;
        const err = new Error('ECONNRESET');
        (err as any).code = 'ECONNRESET';
        throw err;
      },
    },
  );

  return result.then(
    () => assert.fail('should have thrown'),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('all 2 RPCs failed'));
      assert.equal(primaryCallCount, 2, 'primary tried on all RPCs');
    },
  );
});

test('executeWithFallback: custom ErrorClassifier reverses default logic', () => {
  const reverseClassifier: ErrorClassifier = (error) => {
    const code = (error as any)?.code;
    if (code === 'ECONNRESET') return 'try_fallback';
    if (code === 'CALL_EXCEPTION') return 'retry_next_rpc';
    return 'retry_next_rpc';
  };

  const pool = new ProviderPool({ errorClassifier: reverseClassifier });
  const urls = ['https://rpc-a.example'];
  let fallbackCalled = false;

  const result = pool.executeWithFallback(
    1,
    urls,
    {
      primary: async (_p) => {
        const err = new Error('ECONNRESET');
        (err as any).code = 'ECONNRESET';
        throw err;
      },
      fallback: async (_p) => {
        fallbackCalled = true;
        return 'reverse-fallback-result';
      },
    },
  );

  result.then((val) => {
    assert.equal(val, 'reverse-fallback-result');
    assert.equal(fallbackCalled, true, 'custom classifier: ECONNRESET → try_fallback');
  });

  return result;
});

test('executeWithFallback: network error (ECONNRESET) + fallback → skips fallback, next RPC', () => {
  const pool = new ProviderPool();
  const urls = ['https://rpc-a.example', 'https://rpc-b.example'];
  let fallbackCallCount = 0;
  let primaryCallCount = 0;

  const result = pool.executeWithFallback(
    1,
    urls,
    {
      primary: async (_p) => {
        primaryCallCount++;
        if (primaryCallCount === 1) {
          const err = new Error('ECONNRESET');
          (err as any).code = 'ECONNRESET';
          throw err;
        }
        return 'rpc-b-result';
      },
      fallback: async (_p) => {
        fallbackCallCount++;
        return 'fallback-result';
      },
    },
  );

  result.then((val) => {
    assert.equal(val, 'rpc-b-result');
    assert.equal(primaryCallCount, 2, 'primary called on 2 RPCs');
    assert.equal(fallbackCallCount, 0, 'fallback never called because network error skips it');
  });

  return result;
});

test('executeWithFallback: contract error (CALL_EXCEPTION) + fallback → tries fallback on same RPC', () => {
  const pool = new ProviderPool();
  const urls = ['https://rpc-a.example', 'https://rpc-b.example'];
  let fallbackCallCount = 0;
  let primaryCallCount = 0;

  const result = pool.executeWithFallback(
    1,
    urls,
    {
      primary: async (_p) => {
        primaryCallCount++;
        const err = new Error('CALL_EXCEPTION: execution reverted');
        (err as any).code = 'CALL_EXCEPTION';
        throw err;
      },
      fallback: async (_p) => {
        fallbackCallCount++;
        return 'fallback-result';
      },
    },
  );

  result.then((val) => {
    assert.equal(val, 'fallback-result');
    assert.equal(primaryCallCount, 1, 'primary called once on RPC-1');
    assert.equal(fallbackCallCount, 1, 'fallback called once on same RPC because contract error');
  });

  return result;
});
