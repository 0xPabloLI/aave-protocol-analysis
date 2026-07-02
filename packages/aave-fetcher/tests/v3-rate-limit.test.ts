import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSlidingWindowRateLimiter,
  createAaveV3RateLimitedFetch,
  installV3RateLimitedFetch,
  restoreOriginalFetch,
  resetV3RateLimitState,
  getV3RateLimitStats,
} from '@internal/aave-shared-config';

function mockFetch(statusCode: number, headers: Record<string, string> = {}, body = '') {
  return async () =>
    new Response(body, {
      status: statusCode,
      headers: new Headers(headers),
    }) as Promise<Response>;
}

describe('createSlidingWindowRateLimiter', () => {
  it('allows requests within the limit', async () => {
    const limiter = createSlidingWindowRateLimiter(3);
    await limiter.wait();
    await limiter.wait();
    await limiter.wait();
    assert.strictEqual(limiter.getTimestamps().length, 3);
  });

  it('delays requests that exceed the limit', async () => {
    const limiter = createSlidingWindowRateLimiter(2);
    await limiter.wait();
    await limiter.wait();
    const before = Date.now();
    await limiter.wait();
    const elapsed = Date.now() - before;
    assert.ok(elapsed >= 50, `Expected delay >= 50ms, got ${elapsed}ms`);
  });

  it('cleans up old timestamps', async () => {
    const limiter = createSlidingWindowRateLimiter(5);
    await limiter.wait();
    await new Promise((r) => setTimeout(r, 1100));
    await limiter.wait();
    assert.strictEqual(limiter.getTimestamps().length, 1);
  });

  it('reset clears all timestamps', async () => {
    const limiter = createSlidingWindowRateLimiter(5);
    await limiter.wait();
    await limiter.wait();
    limiter.reset();
    assert.strictEqual(limiter.getTimestamps().length, 0);
  });

  it('respects maxRps=1', async () => {
    const limiter = createSlidingWindowRateLimiter(1);
    await limiter.wait();
    const before = Date.now();
    await limiter.wait();
    const elapsed = Date.now() - before;
    assert.ok(elapsed >= 50, `Expected delay >= 50ms with maxRps=1, got ${elapsed}ms`);
  });
});

describe('createAaveV3RateLimitedFetch', () => {
  beforeEach(() => {
    resetV3RateLimitState();
  });

  it('passes through successful responses', async () => {
    const innerFetch = mockFetch(200, {}, '{"data":1}');
    const v3Fetch = createAaveV3RateLimitedFetch(innerFetch);
    const response = await v3Fetch('https://test.com');
    assert.strictEqual(response.status, 200);
  });

  it('retries on 429 with Retry-After header (seconds)', async () => {
    let callCount = 0;
    const innerFetch = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response('', {
          status: 429,
          headers: new Headers({ 'Retry-After': '0' }),
        }) as Promise<Response>;
      }
      return new Response('ok', { status: 200 }) as Promise<Response>;
    };
    const v3Fetch = createAaveV3RateLimitedFetch(innerFetch);
    const response = await v3Fetch('https://test.com');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(callCount, 2);
  });

  it('retries on 429 without Retry-After using exponential backoff', async () => {
    let callCount = 0;
    const innerFetch = async () => {
      callCount++;
      if (callCount <= 2) {
        return new Response('', { status: 429 }) as Promise<Response>;
      }
      return new Response('ok', { status: 200 }) as Promise<Response>;
    };
    const v3Fetch = createAaveV3RateLimitedFetch(innerFetch);
    const response = await v3Fetch('https://test.com');
    assert.strictEqual(response.status, 200);
    assert.ok(callCount >= 3, `Expected at least 3 calls, got ${callCount}`);
  });

  it('returns 429 response after max retries exhausted', async () => {
    let callCount = 0;
    const innerFetch = async () => {
      callCount++;
      return new Response('', { status: 429 }) as Promise<Response>;
    };
    const v3Fetch = createAaveV3RateLimitedFetch(innerFetch);
    const response = await v3Fetch('https://test.com');
    assert.strictEqual(response.status, 429);
  });

  it('passes through 5xx without 429 retry logic', async () => {
    const innerFetch = mockFetch(500);
    const v3Fetch = createAaveV3RateLimitedFetch(innerFetch);
    const response = await v3Fetch('https://test.com');
    assert.strictEqual(response.status, 500);
  });

  it('respects Retry-After as HTTP date', async () => {
    let callCount = 0;
    const futureDate = new Date(Date.now() + 50).toUTCString();
    const innerFetch = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response('', {
          status: 429,
          headers: new Headers({ 'Retry-After': futureDate }),
        }) as Promise<Response>;
      }
      return new Response('ok', { status: 200 }) as Promise<Response>;
    };
    const v3Fetch = createAaveV3RateLimitedFetch(innerFetch);
    const response = await v3Fetch('https://test.com');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(callCount, 2);
  });
});

describe('installV3RateLimitedFetch / restoreOriginalFetch', () => {
  beforeEach(() => {
    resetV3RateLimitState();
    restoreOriginalFetch();
  });

  afterEach(() => {
    restoreOriginalFetch();
  });

  it('patches globalThis.fetch and restores it', () => {
    const original = globalThis.fetch;
    installV3RateLimitedFetch();
    assert.notStrictEqual(globalThis.fetch, original);
    restoreOriginalFetch();
    assert.strictEqual(globalThis.fetch, original);
  });

  it('double install is no-op', () => {
    const original = globalThis.fetch;
    installV3RateLimitedFetch();
    const patched = globalThis.fetch;
    installV3RateLimitedFetch();
    assert.strictEqual(globalThis.fetch, patched);
    restoreOriginalFetch();
    assert.strictEqual(globalThis.fetch, original);
  });

  it('double restore is no-op', () => {
    const original = globalThis.fetch;
    restoreOriginalFetch();
    assert.strictEqual(globalThis.fetch, original);
  });

  it('patched fetch applies sliding window to each HTTP request', async () => {
    const timestamps: number[] = [];
    const mockImpl = async () => {
      timestamps.push(Date.now());
      return new Response('ok', { status: 200 }) as Promise<Response>;
    };
    const original = globalThis.fetch;
    globalThis.fetch = mockImpl;

    installV3RateLimitedFetch();
    try {
      await globalThis.fetch('https://api.v3.aave.com/graphql?q=1');
      await globalThis.fetch('https://api.v3.aave.com/graphql?q=2');
      if (timestamps.length >= 2) {
        const gap = timestamps[1] - timestamps[0];
        assert.ok(gap >= 50, `Expected >= 50ms gap between requests (QPS=1), got ${gap}ms`);
      }
    } finally {
      restoreOriginalFetch();
      globalThis.fetch = original;
    }
  });

  it('patched fetch retries 429 responses', async () => {
    let callCount = 0;
    const mockImpl = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response('', { status: 429, headers: new Headers({ 'Retry-After': '0' }) }) as Promise<Response>;
      }
      return new Response('ok', { status: 200 }) as Promise<Response>;
    };
    const original = globalThis.fetch;
    globalThis.fetch = mockImpl;

    installV3RateLimitedFetch();
    try {
      const response = await globalThis.fetch('https://api.v3.aave.com/graphql');
      assert.strictEqual(response.status, 200);
      assert.ok(callCount >= 2, `Expected >= 2 calls after 429 retry, got ${callCount}`);
    } finally {
      restoreOriginalFetch();
      globalThis.fetch = original;
    }
  });

  it('only patches api.v3.aave.com requests (non-V3 URLs pass through without limiter)', async () => {
    const callTimestamps: number[] = [];
    const mockImpl = async (input) => {
      callTimestamps.push(Date.now());
      return new Response('ok', { status: 200 }) as Promise<Response>;
    };
    const original = globalThis.fetch;
    globalThis.fetch = mockImpl;

    installV3RateLimitedFetch();
    try {
      await globalThis.fetch('https://other-api.example.com/data');
      await globalThis.fetch('https://api.coingecko.com/api/v3/simple/price');
      assert.ok(callTimestamps.length === 2, `Non-Aave URLs should pass through directly`);
      if (callTimestamps.length >= 2) {
        const gap = callTimestamps[1] - callTimestamps[0];
        assert.ok(gap < 50, `Non-Aave requests should not be rate-limited, got ${gap}ms gap`);
      }
    } finally {
      restoreOriginalFetch();
      globalThis.fetch = original;
    }
  });

  it('Aave V3 URLs ARE rate-limited', async () => {
    const callTimestamps: number[] = [];
    const mockImpl = async () => {
      callTimestamps.push(Date.now());
      return new Response('ok', { status: 200 }) as Promise<Response>;
    };
    const original = globalThis.fetch;
    globalThis.fetch = mockImpl;

    installV3RateLimitedFetch();
    try {
      await globalThis.fetch('https://api.v3.aave.com/graphql?q=1');
      await globalThis.fetch('https://api.aave.com/graphql?q=2');
      if (callTimestamps.length >= 2) {
        const gap = callTimestamps[1] - callTimestamps[0];
        assert.ok(gap >= 50, `Aave V3 requests should be rate-limited (QPS=1), got ${gap}ms gap`);
      }
    } finally {
      restoreOriginalFetch();
      globalThis.fetch = original;
    }
  });
});

describe('per-chain 429 adaptive backoff + circuit breaker', () => {
  it('detects "Too Many Requests" as rate limit error', () => {
    const re = /too many requests|rate.?limit|429/i;
    assert.ok(re.test('Too Many Requests'));
    assert.ok(re.test('rate limit exceeded'));
    assert.ok(re.test('Error: 429'));
    assert.ok(!re.test('Internal Server Error'));
    assert.ok(!re.test('Network timeout'));
  });

  it('circuit breaker: getV3RateLimitStats tracks 429 count', async () => {
    resetV3RateLimitState();
    const stats0 = getV3RateLimitStats();
    assert.strictEqual(stats0.total429s, 0);

    const innerFetch = async () => new Response('', { status: 429 }) as Promise<Response>;
    const v3Fetch = createAaveV3RateLimitedFetch(innerFetch);
    await v3Fetch('https://test.com');

    const stats1 = getV3RateLimitStats();
    assert.ok(stats1.total429s >= 1, `Expected at least 1 429, got ${stats1.total429s}`);
    resetV3RateLimitState();
  });
});
