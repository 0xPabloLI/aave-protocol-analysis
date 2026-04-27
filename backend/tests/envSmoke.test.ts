import test from 'node:test';
import assert from 'node:assert/strict';

test('env.ts can be imported without throwing (ESM compatible)', async () => {
  // This smoke test catches ESM-level errors (e.g. require() in ES module scope)
  // that only surface when env.ts is actually imported at runtime.
  const module = await import('../src/env.js');
  assert.ok(module, 'env.ts should load without throwing');
});
