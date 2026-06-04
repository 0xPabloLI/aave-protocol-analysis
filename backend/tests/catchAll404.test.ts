import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { logger } from '../src/logger.js';

const MAX_UA_LEN = 120;
const sanitizeForLog = (s: string) => s.replace(/[\r\n]/g, '_');

function create404App() {
  const app = express();
  app.set('trust proxy', 1);
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use((req, res) => {
    const { method, path: rawPath } = req;
    const path = sanitizeForLog(rawPath);
    const ip = req.ip ?? req.socket.remoteAddress ?? '-';
    const ua = sanitizeForLog((req.headers['user-agent'] ?? '-')).slice(0, MAX_UA_LEN);
    logger.info({ method, path, ip, ua }, '404');
    res.status(404).json({ error: 'Not found', message: `No route for ${method} ${rawPath}`, path: rawPath, method });
  });
  return app;
}

test('404 handler returns JSON with error/message/path/method', async () => {
  const app = create404App();
  const res = await request(app).get('/admin');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Not found');
  assert.equal(res.body.path, '/admin');
  assert.equal(res.body.method, 'GET');
  assert.ok(res.body.message.includes('/admin'));
});

test('404 handler preserves original path (not sanitized) in response body', async () => {
  const app = create404App();
  const res = await request(app).get('/some%20path');
  assert.equal(res.status, 404);
  assert.equal(res.body.path, '/some%20path');
});

test('404 handler sanitizes newlines in path for logs', () => {
  assert.equal(sanitizeForLog('/foo\nbar'), '/foo_bar');
  assert.equal(sanitizeForLog('/foo\rbar'), '/foo_bar');
  assert.equal(sanitizeForLog('/foo\r\nbar'), '/foo__bar');
});

test('404 handler sanitizes newlines in user-agent for logs', () => {
  const maliciousUa = 'bot\r\nFAKE-LOG-ENTRY';
  assert.equal(sanitizeForLog(maliciousUa).includes('\n'), false);
  assert.equal(sanitizeForLog(maliciousUa).includes('\r'), false);
});

test('404 handler truncates user-agent to 120 chars', () => {
  const longUa = 'x'.repeat(200);
  assert.equal(sanitizeForLog(longUa).slice(0, MAX_UA_LEN).length, MAX_UA_LEN);
});

test('known valid route is not caught by 404 handler', async () => {
  const app = create404App();
  const res = await request(app).get('/health');
  assert.equal(res.status, 200);
});

test('404 handler works for POST to unmapped path', async () => {
  const app = create404App();
  const res = await request(app).post('/graphql');
  assert.equal(res.status, 404);
  assert.equal(res.body.method, 'POST');
  assert.equal(res.body.path, '/graphql');
});
