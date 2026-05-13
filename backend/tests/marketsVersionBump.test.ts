import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

it('MARKETS_API_VERSION should be markets-v3 (Phase 4: breaking field rename complete)', async () => {
  const mod = await import('../src/controllers/marketsController.js');
  // @ts-expect-error - MARKETS_API_VERSION will be exported
  const version = mod.MARKETS_API_VERSION;
  assert.equal(version, 'markets-v3',
    `Expected markets-v3 but got ${version}. The 8 field renames are complete; API version must bump to signal breaking change.`);
});