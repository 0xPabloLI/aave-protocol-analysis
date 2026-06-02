import test from 'node:test';
import assert from 'node:assert/strict';
import * as AaveAddressBook from '@aave-dao/aave-address-book';

const SDK_HUBNAME_TO_HUBKEY: Record<string, string> = {
  Core: 'CORE_HUB',
  Prime: 'PRIME_HUB',
  Plus: 'PLUS_HUB',
};

function buildHubNameToHubAddressMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [, val] of Object.entries(AaveAddressBook)) {
    if (!val || typeof val !== 'object') continue;
    const v = val as Record<string, unknown>;
    if (!v.HUBS || typeof v.HUBS !== 'object') continue;
    const hubs = v.HUBS as Record<string, string>;
    for (const [hubKey, hubAddr] of Object.entries(hubs)) {
      if (typeof hubAddr !== 'string') continue;
      const sdkName = Object.entries(SDK_HUBNAME_TO_HUBKEY).find(([, k]) => k === hubKey)?.[0];
      if (sdkName) {
        map.set(sdkName, hubAddr.toLowerCase());
      }
    }
  }
  return map;
}

const ETH_ADDRESS_RE = /^0x[0-9a-f]{40}$/;

function validateHubAddress(addr: string): boolean {
  return ETH_ADDRESS_RE.test(addr);
}

function migrateReserveId(reserveId: string, hubNameMap: Map<string, string>): string | null {
  const parts = reserveId.split(':');
  if (parts.length !== 4) return null;
  const fourth = parts[3];
  if (fourth.startsWith('0x') && fourth.length === 42) return null;
  const hubAddress = hubNameMap.get(fourth);
  if (!hubAddress || !validateHubAddress(hubAddress)) return null;
  return `${parts[0]}:${parts[1]}:${parts[2]}:${hubAddress}`;
}

const hubNameMap = buildHubNameToHubAddressMap();

test('migrateReserveId: Core hubName → hubAddress', () => {
  const old = '1:0x94e7a5dcbe816e498b89ab752661904e2f56c485:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:Core';
  const result = migrateReserveId(old, hubNameMap);
  assert.ok(result);
  const parts = result.split(':');
  assert.strictEqual(parts[3], '0xcca852bc40e560adc3b1cc58ca5b55638ce826c9');
});

test('migrateReserveId: Prime hubName → hubAddress', () => {
  const old = '1:0xspoke:0xtoken:Prime';
  const result = migrateReserveId(old, hubNameMap);
  assert.ok(result);
  assert.ok(result.endsWith(':0x943827dca022d0f354a8a8c332da1e5eb9f9f931'));
});

test('migrateReserveId: Plus hubName → hubAddress', () => {
  const old = '1:0xspoke:0xtoken:Plus';
  const result = migrateReserveId(old, hubNameMap);
  assert.ok(result);
  assert.ok(result.endsWith(':0x06002e9c4412cb7814a791ea3666d905871e536a'));
});

test('migrateReserveId: already-migrated hubAddress is idempotent (returns null)', () => {
  const alreadyMigrated = '1:0xspoke:0xtoken:0xcca852bc40e560adc3b1cc58ca5b55638ce826c9';
  const result = migrateReserveId(alreadyMigrated, hubNameMap);
  assert.strictEqual(result, null, 'already-migrated reserveId should return null (no-op)');
});

test('migrateReserveId: V3 reserveId (3 segments) returns null', () => {
  const v3 = '1:0x87870bca3f3e6a89e12e23a2e01484e8a4a2e7c1:0xbe9895145f349a6695d5da8e9c6b50a9';
  const result = migrateReserveId(v3, hubNameMap);
  assert.strictEqual(result, null);
});

test('migrateReserveId: unknown hubName returns null (cannot migrate)', () => {
  const unknown = '1:0xspoke:0xtoken:Mega';
  const result = migrateReserveId(unknown, hubNameMap);
  assert.strictEqual(result, null);
});

test('migrateReserveId: preserves other segments unchanged', () => {
  const old = '42161:0xabc:0xdef:Core';
  const result = migrateReserveId(old, hubNameMap);
  assert.ok(result);
  assert.ok(result.startsWith('42161:0xabc:0xdef:'));
});

test('hubNameMap contains all three known hubs', () => {
  assert.ok(hubNameMap.has('Core'));
  assert.ok(hubNameMap.has('Prime'));
  assert.ok(hubNameMap.has('Plus'));
  assert.strictEqual(hubNameMap.size, 3);
});

test('validateHubAddress: accepts valid lowercase 0x + 40 hex', () => {
  assert.ok(validateHubAddress('0xcca852bc40e560adc3b1cc58ca5b55638ce826c9'));
  assert.ok(validateHubAddress('0x' + 'a'.repeat(40)));
});

test('validateHubAddress: rejects invalid formats', () => {
  assert.ok(!validateHubAddress(''));
  assert.ok(!validateHubAddress('0x'));
  assert.ok(!validateHubAddress('0x' + 'g'.repeat(40)));
  assert.ok(!validateHubAddress('0X' + 'a'.repeat(40)));
  assert.ok(!validateHubAddress('0x' + 'A'.repeat(40)));
  assert.ok(!validateHubAddress('0x' + 'a'.repeat(39)));
  assert.ok(!validateHubAddress('0x' + 'a'.repeat(41)));
});

test('migrateReserveId: rejects hubName mapping to invalid hubAddress', () => {
  const poisonedMap = new Map<string, string>([['Core', 'NOT_AN_ADDRESS']]);
  const old = '1:0xspoke:0xtoken:Core';
  const result = migrateReserveId(old, poisonedMap);
  assert.strictEqual(result, null);
});
