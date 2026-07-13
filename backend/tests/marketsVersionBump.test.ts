import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

it('MARKETS_API_VERSION should be snapshot-v3 (breaking: deficit hard error + field renames)', async () => {
  const mod = await import('../src/controllers/marketsController.js');
  const version = mod.MARKETS_API_VERSION;
  assert.equal(version, 'snapshot-v3',
    `Expected snapshot-v3 but got ${version}. API version bumped for deficit hard error + field renames.`);
});