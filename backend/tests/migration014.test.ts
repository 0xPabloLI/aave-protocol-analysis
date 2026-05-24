import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', 'migrations');

const migration014Path = join(migrationsDir, '014_fix_oracle_null_unique.sql');
const migration014 = readFileSync(migration014Path, 'utf8');

test('migration 014 exists', () => {
  assert.ok(existsSync(migration014Path), '014_fix_oracle_null_unique.sql must exist');
});

test('migration 014: replaces NULL with empty string in spoke_address', () => {
  assert.match(migration014, /UPDATE\s+oracle_source_configs\s+SET\s+spoke_address\s*=\s*''\s+WHERE\s+spoke_address\s+IS\s+NULL/is);
});

test('migration 014: replaces NULL with empty string in pool_address', () => {
  assert.match(migration014, /UPDATE\s+oracle_source_configs\s+SET\s+pool_address\s*=\s*''\s+WHERE\s+pool_address\s+IS\s+NULL/is);
});

test('migration 014: deduplicates oracle_source_configs (keeps MIN id)', () => {
  assert.match(migration014, /DELETE\s+FROM\s+oracle_source_configs\s+WHERE\s+id\s+NOT\s+IN\s*\(\s*SELECT\s+MIN\s*\(\s*id\s*\)/is);
});

test('migration 014: deduplicates oracle_prices (keeps MIN id)', () => {
  assert.match(migration014, /DELETE\s+FROM\s+oracle_prices\s+WHERE\s+id\s+NOT\s+IN\s*\(\s*SELECT\s+MIN\s*\(\s*id\s*\)/is);
});

test('migration 014: makes pool_address and spoke_address NOT NULL', () => {
  assert.match(migration014, /ALTER\s+COLUMN\s+pool_address\s+SET\s+NOT\s+NULL/is);
  assert.match(migration014, /ALTER\s+COLUMN\s+spoke_address\s+SET\s+NOT\s+NULL/is);
});

test('migration 014: adds unique constraint with all NOT NULL columns', () => {
  assert.match(migration014, /ADD\s+CONSTRAINT\s+\w+\s+UNIQUE\s*\(\s*source\s*,\s*pool_key\s*,\s*chain_id\s*,\s*pool_address\s*,\s*oracle_address\s*,\s*spoke_address\s*\)/is);
});

test('migration 014: runs VACUUM FULL on both tables', () => {
  assert.match(migration014, /VACUUM\s+FULL\s+.*oracle_source_configs/is);
  assert.match(migration014, /VACUUM\s+FULL\s+.*oracle_prices/is);
});

test('migration 014: wraps in transaction (BEGIN/COMMIT)', () => {
  assert.match(migration014, /^BEGIN/m);
  assert.match(migration014, /COMMIT/m);
});
