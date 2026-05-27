import test from 'node:test';
import assert from 'node:assert/strict';
import type { MarketsResponse } from '../src/types/index.js';
import { resolveReserveDeficit } from '../src/services/marketsService.js';

test('MarketsResponse.snapshot includes deficitFallbackReserveIds', () => {
  const response: MarketsResponse = {
    snapshot: {
      lastUpdated: new Date().toISOString(),
      version: 'snapshot-v3',
      staleTimeMs: 0,
      schemaFingerprint: 'test',
      deficitFallbackReserveIds: [],
    },
    reserves: [],
  };
  assert.ok(Array.isArray(response.snapshot.deficitFallbackReserveIds));
  assert.equal(response.snapshot.deficitFallbackReserveIds.length, 0);
});

test('MarketsResponse.snapshot includes v4FallbackReserveIds', () => {
  const response: MarketsResponse = {
    snapshot: {
      lastUpdated: new Date().toISOString(),
      version: 'snapshot-v3',
      staleTimeMs: 0,
      schemaFingerprint: 'test',
      deficitFallbackReserveIds: [],
      v4FallbackReserveIds: ['1:0xspoke:0xtoken:CORE_HUB'],
    },
    reserves: [],
  };
  assert.deepEqual(response.snapshot.v4FallbackReserveIds, ['1:0xspoke:0xtoken:CORE_HUB']);
});

test('MarketsResponse.snapshot deficitFallbackReserveIds can contain reserveIds', () => {
  const response: MarketsResponse = {
    snapshot: {
      lastUpdated: new Date().toISOString(),
      version: 'snapshot-v3',
      staleTimeMs: 0,
      schemaFingerprint: 'test',
      deficitFallbackReserveIds: ['1:0xspoke:0xtoken:CORE_HUB'],
    },
    reserves: [],
  };
  assert.deepEqual(response.snapshot.deficitFallbackReserveIds, ['1:0xspoke:0xtoken:CORE_HUB']);
});

test('resolveReserveDeficit: SDK deficit takes precedence, not fallback', () => {
  const result = resolveReserveDeficit('42', '100');
  assert.strictEqual(result.deficit, '42');
  assert.strictEqual(result.isFallback, false);
});

test('resolveReserveDeficit: SDK deficit "0" still takes precedence (not fallback)', () => {
  const result = resolveReserveDeficit('0', '100');
  assert.strictEqual(result.deficit, '0');
  assert.strictEqual(result.isFallback, false);
});

test('resolveReserveDeficit: no SDK, onchain deficit used, not fallback', () => {
  const result = resolveReserveDeficit(undefined, '77');
  assert.strictEqual(result.deficit, '77');
  assert.strictEqual(result.isFallback, false);
});

test('resolveReserveDeficit: no SDK, onchain deficit "0" used, not fallback', () => {
  const result = resolveReserveDeficit(undefined, '0');
  assert.strictEqual(result.deficit, '0');
  assert.strictEqual(result.isFallback, false);
});

test('resolveReserveDeficit: no SDK, no onchain → fallback to "0"', () => {
  const result = resolveReserveDeficit(undefined, undefined);
  assert.strictEqual(result.deficit, '0');
  assert.strictEqual(result.isFallback, true);
});

test('resolveReserveDeficit: SDK takes precedence even when onchain is undefined', () => {
  const result = resolveReserveDeficit('5', undefined);
  assert.strictEqual(result.deficit, '5');
  assert.strictEqual(result.isFallback, false);
});
