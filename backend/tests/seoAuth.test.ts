import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response, NextFunction } from 'express';

function mockRes() {
  const state = { jsonCalled: false, statusCode: 200, jsonBody: null as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return res; },
    json(body: unknown) { state.jsonCalled = true; state.jsonBody = body; return res; },
  } as unknown as Response;
  return { res, state };
}

test('seoAuthMiddleware: returns 503 when SEO_ADMIN_TOKEN not configured', async () => {
  const { seoAuthMiddleware } = await import('../src/middleware/seoAuth.js');
  const origToken = process.env.SEO_ADMIN_TOKEN;
  delete process.env.SEO_ADMIN_TOKEN;

  const { res, state } = mockRes();
  seoAuthMiddleware({ headers: {} } as Request, res, (() => {}) as NextFunction);

  assert.equal(state.statusCode, 503);
  assert.deepEqual(state.jsonBody, { error: 'SEO admin auth not configured' });

  if (origToken !== undefined) process.env.SEO_ADMIN_TOKEN = origToken;
  else delete process.env.SEO_ADMIN_TOKEN;
});

test('seoAuthMiddleware: returns 401 when X-Admin-Token missing', async () => {
  const { seoAuthMiddleware } = await import('../src/middleware/seoAuth.js');
  const origToken = process.env.SEO_ADMIN_TOKEN;
  process.env.SEO_ADMIN_TOKEN = 'a'.repeat(64);

  const { res, state } = mockRes();
  seoAuthMiddleware({ headers: {} } as Request, res, (() => {}) as NextFunction);

  assert.equal(state.statusCode, 401);

  if (origToken !== undefined) process.env.SEO_ADMIN_TOKEN = origToken;
  else delete process.env.SEO_ADMIN_TOKEN;
});

test('seoAuthMiddleware: returns 401 when token is wrong', async () => {
  const { seoAuthMiddleware } = await import('../src/middleware/seoAuth.js');
  const origToken = process.env.SEO_ADMIN_TOKEN;
  process.env.SEO_ADMIN_TOKEN = 'a'.repeat(64);

  const { res, state } = mockRes();
  seoAuthMiddleware(
    { headers: { 'x-admin-token': 'b'.repeat(64) } } as unknown as Request,
    res,
    (() => {}) as NextFunction,
  );

  assert.equal(state.statusCode, 401);

  if (origToken !== undefined) process.env.SEO_ADMIN_TOKEN = origToken;
  else delete process.env.SEO_ADMIN_TOKEN;
});

test('seoAuthMiddleware: calls next() when token matches', async () => {
  const { seoAuthMiddleware } = await import('../src/middleware/seoAuth.js');
  const origToken = process.env.SEO_ADMIN_TOKEN;
  const token = 'c'.repeat(64);
  process.env.SEO_ADMIN_TOKEN = token;

  let nextCalled = false;
  const { res } = mockRes();
  seoAuthMiddleware(
    { headers: { 'x-admin-token': token } } as unknown as Request,
    res,
    (() => { nextCalled = true; }) as NextFunction,
  );

  assert.equal(nextCalled, true);

  if (origToken !== undefined) process.env.SEO_ADMIN_TOKEN = origToken;
  else delete process.env.SEO_ADMIN_TOKEN;
});

test('seoAuthMiddleware: returns 401 when token length differs', async () => {
  const { seoAuthMiddleware } = await import('../src/middleware/seoAuth.js');
  const origToken = process.env.SEO_ADMIN_TOKEN;
  process.env.SEO_ADMIN_TOKEN = 'a'.repeat(64);

  const { res, state } = mockRes();
  seoAuthMiddleware(
    { headers: { 'x-admin-token': 'short' } } as unknown as Request,
    res,
    (() => {}) as NextFunction,
  );

  assert.equal(state.statusCode, 401);

  if (origToken !== undefined) process.env.SEO_ADMIN_TOKEN = origToken;
  else delete process.env.SEO_ADMIN_TOKEN;
});
