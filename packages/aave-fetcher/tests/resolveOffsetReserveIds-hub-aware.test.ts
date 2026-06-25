import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOffsetReserveIds } from '../src/merkl-api.js';

const makeReserveIdSet = (ids: string[]): Set<string> => new Set(ids);

describe('resolveOffsetReserveIds hub-aware matching', () => {

  describe('V3: same-pool offset (unchanged)', () => {
    it('exact match within same pool', () => {
      const set = makeReserveIdSet([
        '1:0xmainpool:0xusdt',
        '1:0xmainpool:0xusde',
        '1:0xotherpool:0xusde',
      ]);
      const result = resolveOffsetReserveIds('1:0xmainpool:0xusdt', '0xUSDE', set);
      assert.deepEqual(result, ['1:0xmainpool:0xusde']);
    });

    it('no cross-pool match', () => {
      const set = makeReserveIdSet([
        '1:0xmainpool:0xusdt',
        '1:0xotherpool:0xusde',
      ]);
      const result = resolveOffsetReserveIds('1:0xmainpool:0xusdt', '0xusde', set);
      assert.deepEqual(result, []);
    });

    it('hub-cross-spoke returns empty for V3 reserveId', () => {
      const set = makeReserveIdSet([
        '1:0xmainpool:0xusdt',
        '1:0xmainpool:0xusde',
      ]);
      const result = resolveOffsetReserveIds('1:0xmainpool:0xusdt', '0xusde', set, 'hub-cross-spoke');
      assert.deepEqual(result, []);
    });
  });

  describe('default: reserve level matching', () => {
    it('without offsetLevel param, defaults to reserve-level matching', () => {
      const set = makeReserveIdSet([
        '1:0xspokeA:0xusdt:0xhub1',
        '1:0xspokeA:0xusde:0xhub1',
      ]);
      const result = resolveOffsetReserveIds('1:0xspokeA:0xusdt:0xhub1', '0xusde', set);
      assert.deepEqual(result, ['1:0xspokeA:0xusde:0xhub1']);
    });
  });

  describe('hub-cross-spoke offset (V4 HUB_SUPPLY)', () => {
    it('matches offset token across spokes within same hub', () => {
      const set = makeReserveIdSet([
        '1:0xspokeA:0xusdt:0xhub1',
        '1:0xspokeA:0xusde:0xhub1',
        '1:0xspokeB:0xusde:0xhub1',
        '1:0xspokeC:0xusde:0xhub1',
        '1:0xspokeA:0xusde:0xhub2',
      ]);
      const result = resolveOffsetReserveIds('1:0xspokeA:0xusdt:0xhub1', '0xusde', set, 'hub-cross-spoke');
      assert.deepEqual(result.sort(), [
        '1:0xspokeA:0xusde:0xhub1',
        '1:0xspokeB:0xusde:0xhub1',
        '1:0xspokeC:0xusde:0xhub1',
      ].sort());
    });

    it('does NOT match offset token in different hub', () => {
      const set = makeReserveIdSet([
        '1:0xspokeA:0xusdt:0xhub1',
        '1:0xspokeA:0xusde:0xhub2',
      ]);
      const result = resolveOffsetReserveIds('1:0xspokeA:0xusdt:0xhub1', '0xusde', set, 'hub-cross-spoke');
      assert.deepEqual(result, []);
    });

    it('does NOT match offset token on different chain', () => {
      const set = makeReserveIdSet([
        '1:0xspokeA:0xusdt:0xhub1',
        '2:0xspokeA:0xusde:0xhub1',
      ]);
      const result = resolveOffsetReserveIds('1:0xspokeA:0xusdt:0xhub1', '0xusde', set, 'hub-cross-spoke');
      assert.deepEqual(result, []);
    });

    it('returns empty for V3 reserveId (hub-cross-spoke is V4-only)', () => {
      const set = makeReserveIdSet([
        '1:0xmainpool:0xusdt',
        '1:0xmainpool:0xusde',
      ]);
      const result = resolveOffsetReserveIds('1:0xmainpool:0xusdt', '0xusde', set, 'hub-cross-spoke');
      assert.deepEqual(result, []);
    });

    it('self as offset resolves across spokes within same hub', () => {
      const set = makeReserveIdSet([
        '1:0xspokeA:0xusdt:0xhub1',
        '1:0xspokeB:0xusdt:0xhub1',
        '1:0xspokeA:0xusdt:0xhub2',
      ]);
      const result = resolveOffsetReserveIds('1:0xspokeA:0xusdt:0xhub1', '0xusdt', set, 'hub-cross-spoke');
      assert.deepEqual(result.sort(), ['1:0xspokeA:0xusdt:0xhub1', '1:0xspokeB:0xusdt:0xhub1'].sort());
    });
  });

  describe('reserve mode (explicit per-reserve matching)', () => {
    it('V4 reserve mode: exact 4-segment match', () => {
      const set = makeReserveIdSet([
        '1:0xspokeA:0xusdt:0xhub1',
        '1:0xspokeA:0xusde:0xhub1',
        '1:0xspokeB:0xusde:0xhub1',
      ]);
      const result = resolveOffsetReserveIds('1:0xspokeA:0xusdt:0xhub1', '0xusde', set, 'reserve');
      assert.deepEqual(result, ['1:0xspokeA:0xusde:0xhub1']);
    });

    it('V3 reserve mode: same as pool-internal exact match', () => {
      const set = makeReserveIdSet([
        '1:0xmainpool:0xusdt',
        '1:0xmainpool:0xusde',
      ]);
      const result = resolveOffsetReserveIds('1:0xmainpool:0xusdt', '0xusde', set, 'reserve');
      assert.deepEqual(result, ['1:0xmainpool:0xusde']);
    });

    it('V4 reserve mode: does NOT cross spoke boundary', () => {
      const set = makeReserveIdSet([
        '1:0xspokeA:0xusdt:0xhub1',
        '1:0xspokeB:0xusde:0xhub1',
      ]);
      const result = resolveOffsetReserveIds('1:0xspokeA:0xusdt:0xhub1', '0xusde', set, 'reserve');
      assert.deepEqual(result, []);
    });
  });
});
