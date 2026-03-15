import test from 'node:test';
import assert from 'node:assert/strict';

import marketsRouter from '../src/routes/markets.js';

function getRoutePaths(): string[] {
  return marketsRouter.stack
    .filter((layer) => layer.route)
    .map((layer) => layer.route?.path)
    .filter((path): path is string => typeof path === 'string');
}

test('markets router keeps the root snapshot endpoint', () => {
  assert.equal(getRoutePaths().includes('/'), true);
});

test('markets router no longer exposes /list', () => {
  assert.equal(getRoutePaths().includes('/list'), false);
});
