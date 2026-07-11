import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { seoAuthMiddleware } from '../src/middleware/seoAuth.js';
import { getSeoStatus } from '../src/controllers/seoController.js';
import { Router } from 'express';

function createStatusApp(token?: string) {
  const app = express();
  app.use(express.json());
  if (token) process.env.SEO_ADMIN_TOKEN = token;
  const router = Router();
  router.use(seoAuthMiddleware);
  router.get('/status', getSeoStatus);
  app.use('/api/seo', router);
  return app;
}

test('SEO integration: no X-Admin-Token returns 401', async () => {
  const app = createStatusApp('a'.repeat(64));
  const res = await request(app).get('/api/seo/status');
  assert.equal(res.status, 401);
  delete process.env.SEO_ADMIN_TOKEN;
});

test('SEO integration: wrong token returns 401', async () => {
  const app = createStatusApp('a'.repeat(64));
  const res = await request(app).get('/api/seo/status').set('X-Admin-Token', 'b'.repeat(64));
  assert.equal(res.status, 401);
  delete process.env.SEO_ADMIN_TOKEN;
});

test('SEO integration: correct token returns 200', async () => {
  const token = 'c'.repeat(64);
  const app = createStatusApp(token);
  const res = await request(app).get('/api/seo/status').set('X-Admin-Token', token);
  assert.equal(res.status, 200);
  assert.ok(res.body.gsc);
  delete process.env.SEO_ADMIN_TOKEN;
});

test('SEO integration: SEO_ADMIN_TOKEN not configured returns 503', async () => {
  delete process.env.SEO_ADMIN_TOKEN;
  const app = express();
  app.use(express.json());
  const router = Router();
  router.use(seoAuthMiddleware);
  router.get('/status', getSeoStatus);
  app.use('/api/seo', router);
  const res = await request(app).get('/api/seo/status');
  assert.equal(res.status, 503);
});

test('SEO integration: GET /gsc without DB returns 503', async () => {
  const token = 'd'.repeat(64);
  delete process.env.DATABASE_URL;
  const { getGscData } = await import('../src/controllers/seoController.js');
  const app = express();
  app.use(express.json());
  process.env.SEO_ADMIN_TOKEN = token;
  const router = Router();
  router.use(seoAuthMiddleware);
  router.get('/gsc', getGscData);
  app.use('/api/seo', router);
  const res = await request(app).get('/api/seo/gsc?from=2026-05-10&to=2026-05-18').set('X-Admin-Token', token);
  assert.equal(res.status, 503);
  delete process.env.SEO_ADMIN_TOKEN;
});

test('SEO integration: POST /semrush/batch without DB returns 503', async () => {
  const token = 'd'.repeat(64);
  delete process.env.DATABASE_URL;
  const { batchUpsertSemrushSnapshots } = await import('../src/controllers/seoController.js');
  const app = express();
  app.use(express.json());
  process.env.SEO_ADMIN_TOKEN = token;
  const router = Router();
  router.use(seoAuthMiddleware);
  router.post('/semrush/batch', batchUpsertSemrushSnapshots);
  app.use('/api/seo', router);
  const res = await request(app).post('/api/seo/semrush/batch').set('X-Admin-Token', token).send({ snapshots: [] });
  assert.equal(res.status, 503);
  delete process.env.SEO_ADMIN_TOKEN;
});
