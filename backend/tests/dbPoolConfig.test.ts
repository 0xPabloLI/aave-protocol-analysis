import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('dbPool uses max=3 connections (memory optimisation for 1GB container)', () => {
  const src = readFileSync(new URL('../src/services/dbPool.ts', import.meta.url), 'utf8');
  const match = src.match(/max:\s*(\d+)/);
  assert.ok(match, 'dbPool.ts should contain a max: N config');
  assert.equal(Number(match[1]), 3, 'Pool max should be 3 (reduced from 5 to save native memory)');
});
