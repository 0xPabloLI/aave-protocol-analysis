import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isWithinLookbackWindow, ENDED_CAMPAIGN_LOOKBACK_DAYS } from '../src/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('isWithinLookbackWindow', () => {
  const now = Date.now();

  test('returns false for undefined endedAt', () => {
    assert.equal(isWithinLookbackWindow(undefined, now), false);
  });

  test('returns false for invalid date string', () => {
    assert.equal(isWithinLookbackWindow('not-a-date', now), false);
  });

  test('returns false for future endedAt', () => {
    const future = new Date(now + DAY_MS).toISOString();
    assert.equal(isWithinLookbackWindow(future, now), false);
  });

  test('returns true for campaign ended 5 days ago with default 90-day lookback', () => {
    const ended = new Date(now - 5 * DAY_MS).toISOString();
    assert.equal(isWithinLookbackWindow(ended, now), true);
  });

  test('returns true for campaign ended 80 days ago with default 90-day lookback', () => {
    const ended = new Date(now - 80 * DAY_MS).toISOString();
    assert.equal(isWithinLookbackWindow(ended, now), true);
  });

  test('returns false for campaign ended 91 days ago with default 90-day lookback', () => {
    const ended = new Date(now - 91 * DAY_MS).toISOString();
    assert.equal(isWithinLookbackWindow(ended, now), false);
  });

  test('returns false for campaign ended 5 days ago with lookbackDays=3', () => {
    const ended = new Date(now - 5 * DAY_MS).toISOString();
    assert.equal(isWithinLookbackWindow(ended, now, 3), false);
  });

  test('returns true for campaign ended 5 days ago with lookbackDays=7', () => {
    const ended = new Date(now - 5 * DAY_MS).toISOString();
    assert.equal(isWithinLookbackWindow(ended, now, 7), true);
  });

  test('returns false for campaign ended 8 days ago with lookbackDays=7', () => {
    const ended = new Date(now - 8 * DAY_MS).toISOString();
    assert.equal(isWithinLookbackWindow(ended, now, 7), false);
  });

  test('ENDED_CAMPAIGN_LOOKBACK_DAYS equals 90', () => {
    assert.equal(ENDED_CAMPAIGN_LOOKBACK_DAYS, 90);
  });
});
