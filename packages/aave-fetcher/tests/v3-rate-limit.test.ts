import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSlidingWindowRateLimiter,
  createAaveV3RateLimitedFetch,
  resetV3RateLimitState,
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
