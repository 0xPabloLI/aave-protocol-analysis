import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const serverSource = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('server keeps the aggregated public data routes', () => {
  assert.match(serverSource, /app\.use\('\/api\/markets', marketsRouter\)/);
  assert.match(serverSource, /app\.use\('\/api\/meta', metaRouter\)/);
});

test('server no longer mounts deprecated standalone side-data routes', () => {
  assert.doesNotMatch(serverSource, /app\.use\('\/api\/coingecko-categories', coingeckoRouter\)/);
  assert.doesNotMatch(serverSource, /app\.use\('\/api\/coingecko-fdv', coingeckoFdvRouter\)/);
  assert.doesNotMatch(serverSource, /app\.use\('\/api\/campaigns', campaignsRouter\)/);
});
