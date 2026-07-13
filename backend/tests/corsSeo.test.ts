import { test } from 'node:test';
import assert from 'node:assert/strict';

test('normalizeOrigin strips default port 443 for https', async () => {
  const { normalizeOrigin } = await import('../src/middleware/corsOrigin.js');
  assert.equal(normalizeOrigin('https://aaveapy.com:443'), 'https://aaveapy.com');
});

test('normalizeOrigin strips default port 80 for http', async () => {
  const { normalizeOrigin } = await import('../src/middleware/corsOrigin.js');
  assert.equal(normalizeOrigin('http://localhost:80'), 'http://localhost');
});

test('normalizeOrigin keeps non-default port', async () => {
  const { normalizeOrigin } = await import('../src/middleware/corsOrigin.js');
  assert.equal(normalizeOrigin('http://localhost:5173'), 'http://localhost:5173');
});

test('normalizeOrigin returns null for invalid URL', async () => {
  const { normalizeOrigin } = await import('../src/middleware/corsOrigin.js');
  assert.equal(normalizeOrigin('not-a-url'), null);
});

test('isOriginAllowed exact match — prevents subdomain bypass', async () => {
  const { isOriginAllowed } = await import('../src/middleware/corsOrigin.js');
  assert.equal(isOriginAllowed('https://aaveapy.com', ['https://aaveapy.com']), true);
  assert.equal(isOriginAllowed('https://evil.aaveapy.com', ['https://aaveapy.com']), false);
});

test('parseSeoOrigins splits SEO_ALLOWED_ORIGINS', async () => {
  const { parseSeoOrigins } = await import('../src/middleware/corsOrigin.js');
  const orig = process.env.SEO_ALLOWED_ORIGINS;
  process.env.SEO_ALLOWED_ORIGINS = 'https://aaveapy.lovable.app,https://preview.lovable.app';
  const origins = parseSeoOrigins();
  assert.deepEqual(origins, ['https://aaveapy.lovable.app', 'https://preview.lovable.app']);
  if (orig !== undefined) process.env.SEO_ALLOWED_ORIGINS = orig;
  else delete process.env.SEO_ALLOWED_ORIGINS;
});

test('parseSeoOrigins returns empty when not set', async () => {
  const { parseSeoOrigins } = await import('../src/middleware/corsOrigin.js');
  const orig = process.env.SEO_ALLOWED_ORIGINS;
  delete process.env.SEO_ALLOWED_ORIGINS;
  assert.deepEqual(parseSeoOrigins(), []);
  if (orig !== undefined) process.env.SEO_ALLOWED_ORIGINS = orig;
  else delete process.env.SEO_ALLOWED_ORIGINS;
});

test('SEO_ALLOWED_ORIGINS exact match — prevents evil subdomain', async () => {
  const { isOriginAllowed, parseSeoOrigins } = await import('../src/middleware/corsOrigin.js');
  const orig = process.env.SEO_ALLOWED_ORIGINS;
  process.env.SEO_ALLOWED_ORIGINS = 'https://aaveapy.lovable.app';
  const seoOrigins = parseSeoOrigins();
  assert.equal(isOriginAllowed('https://aaveapy.lovable.app', seoOrigins), true);
  assert.equal(isOriginAllowed('https://evil.lovable.app', seoOrigins), false);
  if (orig !== undefined) process.env.SEO_ALLOWED_ORIGINS = orig;
  else delete process.env.SEO_ALLOWED_ORIGINS;
});
