import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const oracleServiceSource = readFileSync(join(__dirname, '..', 'src', 'services', 'oracleService.ts'), 'utf8');
const generatedSource = readFileSync(join(__dirname, '..', 'src', 'generated', 'oracle-pool-configs.ts'), 'utf8');

test('V4 spoke configs have no Horizons manual override', () => {
  assert.doesNotMatch(oracleServiceSource, /spokeName:\s*['"]Horizons['"]/);
  assert.doesNotMatch(oracleServiceSource, /0x3a0Eb5E08d2e8337C2972dA8EAcF5a7e74A187C6/i);
});

test('V4 spoke configs have no TREASURY_SPOKE address', () => {
  assert.doesNotMatch(generatedSource, /0xb9b0b8616f6bf6841972a52058132be08d723155/i);
});

test('generated V4 spoke configs all have oracle addresses', () => {
  const v4Section = generatedSource.slice(generatedSource.indexOf('SYNCED_V4_SPOKE_CONFIGS'));
  const spokeMatches = [...v4Section.matchAll(/spokeAddress:\s*['"]([^'"]+)['"]/g)];
  const oracleMatches = [...v4Section.matchAll(/oracleAddress:\s*['"]([^'"]+)['"]/g)];
  assert.equal(spokeMatches.length, oracleMatches.length, 'every V4 spoke should have an oracle');
  assert.ok(spokeMatches.length > 0, 'should have at least one V4 spoke');
  for (const m of oracleMatches) {
    assert.ok(m[1].startsWith('0x'), `oracle address should be hex: ${m[1]}`);
    assert.equal(m[1].length, 42, `oracle address should be 42 chars: ${m[1]}`);
  }
});

test('oracleService comment mentions TREASURY_SPOKE exclusion reason', () => {
  assert.match(oracleServiceSource, /TREASURY_SPOKE.*no oracle/i);
});

test('V3 Horizon pool is still present in generated configs', () => {
  assert.match(generatedSource, /AaveV3EthereumHorizon/);
});
