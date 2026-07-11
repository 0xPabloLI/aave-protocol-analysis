import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fifoEvict } from '../src/index.js';

describe('fifoEvict', () => {
  test('does nothing when map size <= maxEntries', () => {
    const m = new Map<string, number>([['a', 1], ['b', 2]]);
    fifoEvict(m, 5);
    assert.equal(m.size, 2);
  });

  test('evicts oldest entries when size exceeds maxEntries', () => {
    const m = new Map<string, number>();
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3);
    m.set('d', 4);
    fifoEvict(m, 2);
    assert.equal(m.size, 2);
    assert.equal(m.has('c'), true);
    assert.equal(m.has('d'), true);
    assert.equal(m.has('a'), false);
    assert.equal(m.has('b'), false);
  });

  test('works with maxEntries = 0 (evicts all)', () => {
    const m = new Map<string, number>([['a', 1], ['b', 2]]);
    fifoEvict(m, 0);
    assert.equal(m.size, 0);
  });

  test('handles empty map', () => {
    const m = new Map<string, number>();
    fifoEvict(m, 5);
    assert.equal(m.size, 0);
  });

  test('preserves insertion order for remaining entries', () => {
    const m = new Map<number, string>();
    for (let i = 0; i < 10; i++) m.set(i, `v${i}`);
    fifoEvict(m, 3);
    const keys = [...m.keys()];
    assert.deepStrictEqual(keys, [7, 8, 9]);
  });

  test('works with Map<number, unknown>', () => {
    const m = new Map<number, unknown>();
    m.set(1, 'a');
    m.set(2, 'b');
    m.set(3, 'c');
    fifoEvict(m, 1);
    assert.equal(m.size, 1);
    assert.equal(m.get(3), 'c');
  });

  test('handles falsy keys (0, empty string)', () => {
    const m = new Map<number, string>();
    m.set(0, 'zero');
    m.set(1, 'one');
    m.set(2, 'two');
    fifoEvict(m, 2);
    assert.equal(m.size, 2);
    assert.equal(m.has(0), false);
    assert.equal(m.has(1), true);
    assert.equal(m.has(2), true);
  });
});
