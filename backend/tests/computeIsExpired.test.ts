import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeIsExpired } from '../src/services/marketsApiSerialize.js';

test('computeIsExpired: endDate undefined → false', () => {
  assert.equal(computeIsExpired(undefined), false);
});

test('computeIsExpired: endDate empty string → false', () => {
  assert.equal(computeIsExpired(''), false);
});

test('computeIsExpired: endDate null → false', () => {
  assert.equal(computeIsExpired(null as unknown as string), false);
});

test('computeIsExpired: invalid date format → false', () => {
  assert.equal(computeIsExpired('not-a-date'), false);
});

test('computeIsExpired: past endDate → true', () => {
  const now = new Date('2025-06-01T00:00:00Z');
  assert.equal(computeIsExpired('2025-01-01T00:00:00Z', now), true);
});

test('computeIsExpired: future endDate → false', () => {
  const now = new Date('2025-06-01T00:00:00Z');
  assert.equal(computeIsExpired('2025-12-31T00:00:00Z', now), false);
});

test('computeIsExpired: exact endDate → false (now == endDate)', () => {
  const now = new Date('2025-06-01T00:00:00Z');
  assert.equal(computeIsExpired('2025-06-01T00:00:00Z', now), false);
});

test('computeIsExpired: 1ms past endDate → true', () => {
  const now = new Date('2025-06-01T00:00:01Z');
  assert.equal(computeIsExpired('2025-06-01T00:00:00Z', now), true);
});

test('computeIsExpired: uses Date.now() when now not provided', () => {
  const past = '2000-01-01T00:00:00Z';
  assert.equal(computeIsExpired(past), true);
});

// ── Boundary cases (Task 9.3) ─────────────────────────────────────────────

test('computeIsExpired: endDate just before now → true', () => {
  const now = new Date('2025-06-01T12:00:00Z');
  assert.equal(computeIsExpired('2025-06-01T11:59:59Z', now), true);
});

test('computeIsExpired: endDate exactly now → false (boundary inclusive)', () => {
  const now = new Date('2025-06-01T12:00:00Z');
  assert.equal(computeIsExpired('2025-06-01T12:00:00Z', now), false);
});

test('computeIsExpired: endDate 1ms after now → false', () => {
  const now = new Date('2025-06-01T12:00:00Z');
  assert.equal(computeIsExpired('2025-06-01T12:00:00.001Z', now), false);
});

test('computeIsExpired: whitespace-only endDate → false', () => {
  assert.equal(computeIsExpired('   '), false);
});
