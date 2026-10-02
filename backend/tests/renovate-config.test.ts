import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

function readConfig(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf-8');
}

test('renovate.json is valid JSON with required keys', () => {
  const config = JSON.parse(readConfig('renovate.json'));
  assert.ok(config.$schema);
  assert.deepEqual(config.extends, ['config:best-practices']);
  assert.ok(config.osvVulnerabilityAlerts, 'osvVulnerabilityAlerts must be enabled');
});

test('renovate targets the railway branch', () => {
  const config = JSON.parse(readConfig('renovate.json'));
  assert.deepEqual(config.baseBranches, ['railway']);
});

test('renovate enforces the 7-day dependency cool-down', () => {
  const config = JSON.parse(readConfig('renovate.json'));
  assert.equal(config.minimumReleaseAge, '7 days');
});

test('address-book upgrade rule is present with its label', () => {
  const config = JSON.parse(readConfig('renovate.json'));
  const rule = config.packageRules.find((r: { matchDepNames?: string[] }) =>
    r.matchDepNames?.includes('@aave-dao/aave-address-book')
  );
  assert.ok(rule, 'address-book packageRule not found');
  assert.ok(rule.labels.includes('address-book-upgrade'));
});

test('ethers major updates stay disabled (pinned exact by policy)', () => {
  const config = JSON.parse(readConfig('renovate.json'));
  const rule = config.packageRules.find((r: { matchDepNames?: string[] }) =>
    r.matchDepNames?.includes('ethers')
  );
  assert.ok(rule, 'ethers packageRule not found');
  assert.equal(rule.enabled, false);
});

test('dependabot.yml is gone (Renovate migration complete)', () => {
  let existed = true;
  try {
    readConfig('.github/dependabot.yml');
  } catch {
    existed = false;
  }
  assert.ok(!existed, '.github/dependabot.yml should be deleted');
});

test('auto-merge bot workflow YAML is valid', () => {
  const content = readConfig('.github/workflows/auto-merge-bot-prs.yml');
  assert.ok(content.length > 0);
  assert.ok(content.includes('name:'));
  assert.ok(content.includes('jobs:'));
});

test('auto-merge workflow filters for renovate[bot] actor', () => {
  const content = readConfig('.github/workflows/auto-merge-bot-prs.yml');
  assert.ok(
    content.includes('renovate[bot]'),
    'auto-merge must filter for renovate[bot] actor'
  );
});
