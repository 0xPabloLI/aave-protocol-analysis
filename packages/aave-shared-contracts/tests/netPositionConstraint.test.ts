import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NetPositionConstraint } from '../dist/index.js';

describe('NetPositionConstraint', () => {
  it('should be importable from @internal/aave-shared-contracts', () => {
    const constraint: NetPositionConstraint = {
      sourceSide: 'supply',
      offsetReserveIds: ['1:0xpool:0xusde'],
    };
    assert.strictEqual(constraint.sourceSide, 'supply');
    assert.deepStrictEqual(constraint.offsetReserveIds, ['1:0xpool:0xusde']);
  });

  it('should accept borrow as sourceSide', () => {
    const constraint: NetPositionConstraint = {
      sourceSide: 'borrow',
      offsetReserveIds: [],
    };
    assert.strictEqual(constraint.sourceSide, 'borrow');
  });
});
