import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOffsetReserveIds } from '../src/merkl-api.js';

const makeReserveIdSet = (ids: string[]): Set<string> => new Set(ids);

describe('AAV-906: resolveOffsetReserveIds hub-aware matching', () => {

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
  });

  describe('V4 Hub campaign: offset at hub level', () => {
    it('matches offset token in same hub, same spoke', () => {
      const set = makeReserveIdSet([
        '1:0xspokeA:0xusdt:0xhub1',
        '1:0xspokeA:0xusde:0xhub1',
        '1:0xspokeA:0xusdt:0xhub2',
        '1:0xspokeA:0xusde:0xhub2',
        '1:0xspokeB:0xusde:0xhub1',
      ]);
      const result = resolveOffsetReserveIds('1:0xspokeA:0xusdt:0xhub1', '0xusde', set, 'hub');
      assert.deepEqual(result, ['1:0xspokeA:0xusde:0xhub1']);
    });

    it('does NOT match offset token in different hub (same spoke)', () => {
      const set = makeReserveIdSet([
        '1:0xspokeA:0xusdt:0xhub1',
        '1:0xspokeA:0xusde:0xhub2',
      ]);
      const result = resolveOffsetReserveIds('1:0xspokeA:0xusdt:0xhub1', '0xusde', set, 'hub');
      assert.deepEqual(result, []);
    });

    it('does NOT match offset token in different spoke (same hub)', () => {
      const set = makeReserveIdSet([
        '1:0xspokeA:0xusdt:0xhub1',
        '1:0xspokeB:0xusde:0xhub1',
      ]);
      const result = resolveOffsetReserveIds('1:0xspokeA:0xusdt:0xhub1', '0xusde', set, 'hub');
      assert.deepEqual(result, []);
    });

    it('self as offset resolves correctly', () => {
      const set = makeReserveIdSet([
        '1:0xspokeA:0xusdt:0xhub1',
      ]);
      const result = resolveOffsetReserveIds('1:0xspokeA:0xusdt:0xhub1', '0xusdt', set, 'hub');
      assert.deepEqual(result, ['1:0xspokeA:0xusdt:0xhub1']);
    });
  });

  describe('V4 Spoke campaign: offset at spoke level', () => {
    it('matches offset token across hubs under same spoke', () => {
      const set = makeReserveIdSet([
        '1:0xspokeA:0xusdt:0xhub1',
        '1:0xspokeA:0xusde:0xhub1',
        '1:0xspokeA:0xusde:0xhub2',
        '1:0xspokeB:0xusde:0xhub1',
      ]);
      const result = resolveOffsetReserveIds('1:0xspokeA:0xusdt:0xhub2', '0xusde', set, 'spoke');
      assert.deepEqual(result.sort(), ['1:0xspokeA:0xusde:0xhub1', '1:0xspokeA:0xusde:0xhub2'].sort());
    });

    it('does NOT match offset token in different spoke', () => {
      const set = makeReserveIdSet([
        '1:0xspokeA:0xusdt:0xhub1',
        '1:0xspokeB:0xusde:0xhub1',
        '1:0xspokeA:0xusde:0xhub1',
      ]);
      const result = resolveOffsetReserveIds('1:0xspokeA:0xusdt:0xhub1', '0xusde', set, 'spoke');
      assert.deepEqual(result, ['1:0xspokeA:0xusde:0xhub1']);
    });
  });

  describe('V4 default: hub level (backward compatible)', () => {
    it('without offsetLevel param, defaults to hub-level matching', () => {
      const set = makeReserveIdSet([
        '1:0xspokeA:0xusdt:0xhub1',
        '1:0xspokeA:0xusde:0xhub1',
        '1:0xspokeA:0xusde:0xhub2',
      ]);
      const result = resolveOffsetReserveIds('1:0xspokeA:0xusdt:0xhub1', '0xusde', set);
      assert.deepEqual(result, ['1:0xspokeA:0xusde:0xhub1']);
    });

    it("'hub' alias maps to 'reserve' behavior", () => {
      const set = makeReserveIdSet([
        '1:0xspokeA:0xusdt:0xhub1',
        '1:0xspokeA:0xusde:0xhub1',
      ]);
      const result = resolveOffsetReserveIds('1:0xspokeA:0xusdt:0xhub1', '0xusde', set, 'hub');
      assert.deepEqual(result, ['1:0xspokeA:0xusde:0xhub1']);
    });

    it("'spoke' alias maps to 'spoke-cross-hub' behavior", () => {
      const set = makeReserveIdSet([
        '1:0xspokeA:0xusdt:0xhub1',
        '1:0xspokeA:0xusde:0xhub1',
        '1:0xspokeA:0xusde:0xhub2',
      ]);
      const result = resolveOffsetReserveIds('1:0xspokeA:0xusdt:0xhub1', '0xusde', set, 'spoke');
      assert.deepEqual(result.sort(), ['1:0xspokeA:0xusde:0xhub1', '1:0xspokeA:0xusde:0xhub2'].sort());
    });
  });

  describe('AAV-997: hub-cross-spoke offset (V4 HUB_SUPPLY)', () => {
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

  describe('AAV-997: reserve mode (explicit per-reserve matching)', () => {
    it('V4 reserve mode: exact 4-segment match', () => {
      const set = makeReserveIdSet([
        '1:0xspokeA:0xusdt:0xhub1',
        '1:0xspokeA:0xusde:0xhub1',
        '1:0xspokeB:0xusde:0xhub1',
      ]);
      const result = resolveOffsetReserveIds('1:0xspokeA:0xusdt:0xhub1', '0xusde', set, 'reserve');
      assert.deepEqual(result, ['1:0xspokeA:0xusde:0xhub1']);
    });

    it('V3 reserve mode: same as hub-level exact match', () => {
      const set = makeReserveIdSet([
        '1:0xmainpool:0xusdt',
        '1:0xmainpool:0xusde',
      ]);
      const result = resolveOffsetReserveIds('1:0xmainpool:0xusdt', '0xusde', set, 'reserve');
      assert.deepEqual(result, ['1:0xmainpool:0xusde']);
    });
  });
});
