import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

function parseYaml(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf-8');
}

test('dependabot.yml is valid YAML (parses without error)', () => {
  const content = parseYaml('.github/dependabot.yml');
  assert.ok(content.length > 0);
  assert.ok(content.includes('version: 2'));
  assert.ok(content.includes('updates:'));
});

test('address-book has allow rule for version upgrades', () => {
  const content = parseYaml('.github/dependabot.yml');
  assert.ok(
    content.includes('@aave-dao/aave-address-book'),
    'missing @aave-dao/aave-address-book in allow rules'
  );
  const allowBlockMatch = content.match(/allow:\s*\n\s*-\s*dependency-name:\s*"@aave-dao\/aave-address-book"/);
  assert.ok(allowBlockMatch, 'allow rule for address-book not found');
});

test('address-book rule targets railway branch', () => {
  const content = parseYaml('.github/dependabot.yml');
  const lines = content.split('\n');
  const allowLineIdx = lines.findIndex((l) =>
    l.includes('dependency-name: "@aave-dao/aave-address-book"')
  );
  assert.ok(allowLineIdx !== -1, 'address-book allow rule not found');
  const surroundingLines = lines.slice(0, allowLineIdx + 1);
  const lastTargetBranch = [...surroundingLines]
    .reverse()
    .find((l) => l.trim().startsWith('target-branch:'));
  assert.ok(
    lastTargetBranch?.includes('railway'),
    `address-book target-branch is not 'railway': ${lastTargetBranch}`
  );
});

test('other dependencies have no version-update allow rules (security-only)', () => {
  const content = parseYaml('.github/dependabot.yml');
  const allowBlockCount = (content.match(/^(\s*)allow:/gm) || []).length;
  assert.ok(
    allowBlockCount === 1,
    `expected exactly 1 allow block (address-book only), found ${allowBlockCount}`
  );
});

test('auto-merge workflow YAML is valid', () => {
  const content = parseYaml('.github/workflows/auto-merge-dependabot.yml');
  assert.ok(content.length > 0);
  assert.ok(content.includes('name:'));
  assert.ok(content.includes('on:'));
  assert.ok(content.includes('jobs:'));
});

test('auto-merge workflow filters for dependabot[bot] actor', () => {
  const content = parseYaml('.github/workflows/auto-merge-dependabot.yml');
  assert.ok(
    content.includes("dependabot[bot]") || content.includes("'dependabot[bot]'"),
    'auto-merge must filter for dependabot[bot] actor'
  );
});

test('auto-merge workflow checks for address-book specifically', () => {
  const content = parseYaml('.github/workflows/auto-merge-dependabot.yml');
  assert.ok(
    content.includes('@aave-dao/aave-address-book'),
    'auto-merge must check for address-book dependency specifically'
  );
});
