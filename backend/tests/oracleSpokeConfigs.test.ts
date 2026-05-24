import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { V3_ENTRIES, V4_SPOKE_ENTRIES } from '../src/services/addressBookRegistry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const oracleServiceSource = readFileSync(join(__dirname, '..', 'src', 'services', 'oracleService.ts'), 'utf8');
const registrySource = readFileSync(join(__dirname, '..', 'src', 'services', 'addressBookRegistry.ts'), 'utf8');

test('V4 spoke configs have no Horizons manual override', () => {
  assert.doesNotMatch(oracleServiceSource, /spokeName:\s*['"]Horizons['"]/);
  assert.doesNotMatch(oracleServiceSource, /0x3a0Eb5E08d2e8337C2972dA8EAcF5a7e74A187C6/i);
});

test('V4 spoke configs have no TREASURY_SPOKE address (enforced by registry)', () => {
  const treasurySpoke = V4_SPOKE_ENTRIES.filter((e) => e.spokeKey === 'TREASURY_SPOKE');
  assert.strictEqual(treasurySpoke.length, 0, 'TREASURY_SPOKE should be excluded');
});

test('all registry V4 spoke oracle entries have valid oracle addresses', () => {
  const oracleEntries = V4_SPOKE_ENTRIES.filter((e) => !!e.oracleAddress);
  assert.ok(oracleEntries.length > 0, 'should have at least one V4 spoke with oracle');
  for (const e of oracleEntries) {
    assert.ok(e.oracleAddress!.startsWith('0x'), `oracle address should be hex: ${e.oracleAddress}`);
    assert.strictEqual(e.oracleAddress!.length, 42, `oracle address should be 42 chars: ${e.oracleAddress}`);
  }
});

test('oracleService comment mentions TREASURY_SPOKE exclusion reason', () => {
  assert.match(oracleServiceSource, /TREASURY_SPOKE.*no oracle/i);
});

test('V3 Horizon pool is present in registry V3 entries', () => {
  const horizonEntry = V3_ENTRIES.find((e) => e.poolKey === 'AaveV3EthereumHorizon');
  assert.ok(horizonEntry, 'AaveV3EthereumHorizon should be in V3_ENTRIES');
  assert.ok(horizonEntry!.oracleAddress, 'should have oracleAddress');
});

test('registry header documents design decisions', () => {
  assert.match(registrySource, /whitelist.*AAVE_CHAIN_ID_TO_RPC_KEY/i);
  assert.match(registrySource, /spokeKey.*spokeName/i);
  assert.match(registrySource, /BLUECHIP_SPOKE.*CORE_HUB.*PRIME_HUB/i);
});

// ── NULL bug guard: ensureOracleSourceConfigs must use '' not null ────────

const persistenceSource = readFileSync(join(__dirname, '..', 'src', 'services', 'persistenceService.ts'), 'utf8');

test('ensureOracleSourceConfigs: V3 spokeAddress is empty string, not null', () => {
  assert.doesNotMatch(
    persistenceSource,
    /spokeAddress:\s*null/,
    'spokeAddress must be empty string (\'\') not null — NULL breaks ON CONFLICT unique constraint'
  );
});

test('ensureOracleSourceConfigs: V4 poolAddress is empty string, not null', () => {
  assert.doesNotMatch(
    persistenceSource,
    /poolAddress:\s*null/,
    'poolAddress must be empty string (\'\') not null — NULL breaks ON CONFLICT unique constraint'
  );
});

test('OracleConfigKey interface: poolAddress and spokeAddress are string, not string | null', () => {
  assert.doesNotMatch(
    persistenceSource,
    /poolAddress:\s*string\s*\|\s*null/,
    'poolAddress type must be `string` (empty string for V4), not `string | null`'
  );
  assert.doesNotMatch(
    persistenceSource,
    /spokeAddress:\s*string\s*\|\s*null/,
    'spokeAddress type must be `string` (empty string for V3), not `string | null`'
  );
});