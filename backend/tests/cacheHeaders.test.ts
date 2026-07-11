import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';

function mockRes(): { res: Response; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const res = {
    getHeader: (name: string) => headers[name] ?? null,
    setHeader: (name: string, value: string) => { headers[name] = value; },
  } as unknown as Response;
  return { res, headers };
}

function mockReq(path: string): Request {
  return { path } as Request;
}

test('health endpoints get no-store', async () => {
  const { apiCacheHeadersMiddleware } = await import('../src/middleware/cacheHeaders.js');
  for (const p of ['/health', '/api/health']) {
    const { res, headers } = mockRes();
    let called = false;
    apiCacheHeadersMiddleware(mockReq(p), res, () => { called = true; });
    assert.equal(headers['Cache-Control'], 'no-store');
    assert.equal(called, true);
  }
});

test('/api/markets gets no-cache, must-revalidate', async () => {
  const { apiCacheHeadersMiddleware } = await import('../src/middleware/cacheHeaders.js');
  const { res, headers } = mockRes();
  apiCacheHeadersMiddleware(mockReq('/api/markets'), res, () => {});
  assert.equal(headers['Cache-Control'], 'no-cache, must-revalidate');
});

test('/api/meta/side-data gets public cache with s-maxage=600', async () => {
  const { apiCacheHeadersMiddleware } = await import('../src/middleware/cacheHeaders.js');
  const { res, headers } = mockRes();
  apiCacheHeadersMiddleware(mockReq('/api/meta/side-data'), res, () => {});
  const cc = headers['Cache-Control'];
  assert.ok(cc?.includes('s-maxage=600'), `expected s-maxage=600, got: ${cc}`);
  assert.ok(cc?.includes('stale-while-revalidate=600'), `expected stale-while-revalidate=600, got: ${cc}`);
  assert.ok(cc?.includes('public'), `expected public, got: ${cc}`);
});

test('unknown paths get no Cache-Control header', async () => {
  const { apiCacheHeadersMiddleware } = await import('../src/middleware/cacheHeaders.js');
  const { res, headers } = mockRes();
  apiCacheHeadersMiddleware(mockReq('/api/unknown'), res, () => {});
  assert.equal(headers['Cache-Control'], undefined);
});

test('pre-existing Cache-Control is not overwritten', async () => {
  const { apiCacheHeadersMiddleware } = await import('../src/middleware/cacheHeaders.js');
  const { res, headers } = mockRes();
  res.setHeader('Cache-Control', 'custom');
  apiCacheHeadersMiddleware(mockReq('/api/markets'), res, () => {});
  assert.equal(headers['Cache-Control'], 'custom');
});
