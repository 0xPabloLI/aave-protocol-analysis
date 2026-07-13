import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', 'migrations');

const squashPath = join(migrationsDir, '001_init_schema.sql');
const squash = readFileSync(squashPath, 'utf8');

test('squash migration 001_init_schema.sql exists', () => {
  assert.ok(existsSync(squashPath), '001_init_schema.sql must exist');
});

test('squash: oracle_source_configs pool_address and spoke_address are NOT NULL', () => {
  assert.match(squash, /pool_address\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+''/);
  assert.match(squash, /spoke_address\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+''/);
});

test('squash: oracle_source_configs has unique constraint with all NOT NULL columns', () => {
  assert.match(squash, /CONSTRAINT\s+oracle_source_configs_unique_key\s+UNIQUE\s*\(\s*source\s*,\s*pool_key\s*,\s*chain_id\s*,\s*pool_address\s*,\s*oracle_address\s*,\s*spoke_address\s*\)/is);
});

test('squash: market_configs has content_hash column', () => {
  assert.match(squash, /content_hash\s+TEXT/);
});

test('squash: archive_jobs table exists', () => {
  assert.match(squash, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+archive_jobs/is);
  assert.match(squash, /triggered_at/);
  assert.match(squash, /workflow_run_id/);
  assert.match(squash, /pg_size_bytes/);
  assert.match(squash, /cleaned_at/);
  assert.match(squash, /error_message/);
});

test('squash: market_snapshots uses renamed columns (liquidity, borrowed, supplied)', () => {
  assert.match(squash, /liquidity\s+NUMERIC/);
  assert.match(squash, /borrowed\s+NUMERIC/);
  assert.match(squash, /supplied\s+NUMERIC/);
  assert.doesNotMatch(squash, /available_liquidity/);
  assert.doesNotMatch(squash, /total_variable_debt/);
  assert.doesNotMatch(squash, /reserve_size/);
});

test('squash: no campaign tables (they were created then dropped)', () => {
  const createTableStatements = squash.match(/CREATE\s+TABLE[^(]*\([^;]*\);/gs) ?? [];
  for (const stmt of createTableStatements) {
    assert.doesNotMatch(stmt, /campaign_history/, 'no campaign_history CREATE TABLE');
    assert.doesNotMatch(stmt, /campaign_apr_observations/, 'no campaign_apr_observations CREATE TABLE');
  }
});

test('squash: no supply_incentives_apr / borrow_incentives_apr (dropped in 012)', () => {
  assert.doesNotMatch(squash, /supply_incentives_apr/);
  assert.doesNotMatch(squash, /borrow_incentives_apr/);
});

test('squash: wraps in transaction (BEGIN/COMMIT)', () => {
  assert.match(squash, /^BEGIN/m);
  assert.match(squash, /COMMIT/m);
});
