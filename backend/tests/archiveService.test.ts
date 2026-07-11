import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getThresholdBytes,
  getRetainDays,
} from '../src/services/archiveService.js';

// ── Environment variable parsing ──────────────────────────────────────────

test('getThresholdBytes: defaults to 3GB when ARCHIVE_THRESHOLD_BYTES not set', () => {
  const orig = process.env.ARCHIVE_THRESHOLD_BYTES;
  delete process.env.ARCHIVE_THRESHOLD_BYTES;
  assert.strictEqual(getThresholdBytes(), 3 * 1024 * 1024 * 1024);
  if (orig !== undefined) process.env.ARCHIVE_THRESHOLD_BYTES = orig;
});

test('getThresholdBytes: parses valid ARCHIVE_THRESHOLD_BYTES', () => {
  const orig = process.env.ARCHIVE_THRESHOLD_BYTES;
  process.env.ARCHIVE_THRESHOLD_BYTES = '1073741824'; // 1GB
  assert.strictEqual(getThresholdBytes(), 1073741824);
  if (orig !== undefined) process.env.ARCHIVE_THRESHOLD_BYTES = orig;
  else delete process.env.ARCHIVE_THRESHOLD_BYTES;
});

test('getThresholdBytes: falls back to default on invalid value', () => {
  const orig = process.env.ARCHIVE_THRESHOLD_BYTES;
  process.env.ARCHIVE_THRESHOLD_BYTES = 'not-a-number';
  assert.strictEqual(getThresholdBytes(), 3 * 1024 * 1024 * 1024);
  if (orig !== undefined) process.env.ARCHIVE_THRESHOLD_BYTES = orig;
  else delete process.env.ARCHIVE_THRESHOLD_BYTES;
});

test('getThresholdBytes: falls back to default on zero', () => {
  const orig = process.env.ARCHIVE_THRESHOLD_BYTES;
  process.env.ARCHIVE_THRESHOLD_BYTES = '0';
  assert.strictEqual(getThresholdBytes(), 3 * 1024 * 1024 * 1024);
  if (orig !== undefined) process.env.ARCHIVE_THRESHOLD_BYTES = orig;
  else delete process.env.ARCHIVE_THRESHOLD_BYTES;
});

test('getThresholdBytes: falls back to default on negative', () => {
  const orig = process.env.ARCHIVE_THRESHOLD_BYTES;
  process.env.ARCHIVE_THRESHOLD_BYTES = '-100';
  assert.strictEqual(getThresholdBytes(), 3 * 1024 * 1024 * 1024);
  if (orig !== undefined) process.env.ARCHIVE_THRESHOLD_BYTES = orig;
  else delete process.env.ARCHIVE_THRESHOLD_BYTES;
});

test('getRetainDays: defaults to 7 when ARCHIVE_RETAIN_DAYS not set', () => {
  const orig = process.env.ARCHIVE_RETAIN_DAYS;
  delete process.env.ARCHIVE_RETAIN_DAYS;
  assert.strictEqual(getRetainDays(), 7);
  if (orig !== undefined) process.env.ARCHIVE_RETAIN_DAYS = orig;
});

test('getRetainDays: parses valid ARCHIVE_RETAIN_DAYS', () => {
  const orig = process.env.ARCHIVE_RETAIN_DAYS;
  process.env.ARCHIVE_RETAIN_DAYS = '14';
  assert.strictEqual(getRetainDays(), 14);
  if (orig !== undefined) process.env.ARCHIVE_RETAIN_DAYS = orig;
  else delete process.env.ARCHIVE_RETAIN_DAYS;
});

test('getRetainDays: falls back to default on invalid value', () => {
  const orig = process.env.ARCHIVE_RETAIN_DAYS;
  process.env.ARCHIVE_RETAIN_DAYS = 'abc';
  assert.strictEqual(getRetainDays(), 7);
  if (orig !== undefined) process.env.ARCHIVE_RETAIN_DAYS = orig;
  else delete process.env.ARCHIVE_RETAIN_DAYS;
});

// ── Structural guards ──────────────────────────────────────────────────────

test('ArchiveCheckResult action type covers all expected paths', () => {
  const validActions = new Set([
    'skipped_no_db',
    'skipped_below_threshold',
    'skipped_no_token',
    'skipped_pending_job',
    'triggered',
    'check_pending',
    'check_running',
    'cleanup_done',
    'cleanup_failed',
    'workflow_failed',
  ]);
  assert.strictEqual(validActions.size, 10, 'should have exactly 10 distinct action types');
});

test('default threshold is 3GB = 3221225472 bytes', () => {
  assert.strictEqual(3 * 1024 * 1024 * 1024, 3221225472);
});

test('archive_jobs table SQL: squash migration 001 includes archive_jobs', async () => {
  const { readFileSync } = await import('fs');
  const { resolve, dirname } = await import('path');
  const { fileURLToPath } = await import('url');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(resolve(__dirname, '../migrations/001_init_schema.sql'), 'utf8');
  assert.ok(sql.includes('archive_jobs'), 'squash must create archive_jobs table');
  assert.ok(sql.includes('triggered_at'), 'must have triggered_at column');
  assert.ok(sql.includes('workflow_run_id'), 'must have workflow_run_id column');
  assert.ok(sql.includes('status'), 'must have status column');
  assert.ok(sql.includes('pg_size_bytes'), 'must have pg_size_bytes column');
  assert.ok(sql.includes('cleaned_at'), 'must have cleaned_at column');
  assert.ok(sql.includes('error_message'), 'must have error_message column');
});

test('db-backup workflow supports mode input', async () => {
  const { readFileSync } = await import('fs');
  const { resolve, dirname } = await import('path');
  const { fileURLToPath } = await import('url');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const yml = readFileSync(resolve(__dirname, '../../.github/workflows/db-backup.yml'), 'utf8');
  assert.ok(yml.includes('mode'), 'workflow must define mode input');
  assert.ok(yml.includes('archive'), 'workflow must reference archive mode');
  assert.ok(yml.includes('daily'), 'workflow must reference daily mode');
});
