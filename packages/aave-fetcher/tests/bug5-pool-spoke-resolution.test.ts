import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Bug5: pool/spoke-scoped offset resolution', () => {

  describe('V3: same-pool offset → exact match', () => {
    it('offset token in same pool resolves to correct reserveId', () => {
      const oppReserveId = '1:0xmainpool:0xusdt';
      const reserveIdSet = new Set([
        '1:0xmainpool:0xusdt',
        '1:0xmainpool:0xusde',
        '1:0xmainpool:0xgho',
        '1:0xhorizonpool:0xrlusd',
      ]);
      const offsetTokenAddress = '0xusde';
      const result = resolveOffsetReserveId(oppReserveId, offsetTokenAddress, reserveIdSet);
      assert.equal(result, '1:0xmainpool:0xusde');
    });

    it('cross-pool same token does NOT match (Bug5 core)', () => {
      const oppReserveId = '1:0xhorizonpool:0xrlusd';
      const reserveIdSet = new Set([
        '1:0xhorizonpool:0xrlusd',
        '1:0xmainpool:0xusde',
        '1:0xhorizonpool:0xusde',
      ]);
      const offsetTokenAddress = '0xusde';
      const result = resolveOffsetReserveId(oppReserveId, offsetTokenAddress, reserveIdSet);
      assert.equal(result, '1:0xhorizonpool:0xusde');
      assert.notEqual(result, '1:0xmainpool:0xusde');
    });

    it('offset token not in same pool returns undefined', () => {
      const oppReserveId = '1:0xhorizonpool:0xrlusd';
      const reserveIdSet = new Set([
        '1:0xhorizonpool:0xrlusd',
        '1:0xmainpool:0xusde',
      ]);
      const offsetTokenAddress = '0xusde';
      const result = resolveOffsetReserveId(oppReserveId, offsetTokenAddress, reserveIdSet);
      assert.equal(result, undefined);
    });
  });

  describe('V4: same-spoke offset → match across hubs', () => {
    it('offset token in same spoke returns all hub reserveIds', () => {
      const oppReserveId = '1:0xspoke:0xusdt:Core';
      const reserveIdSet = new Set([
        '1:0xspoke:0xusdt:Core',
        '1:0xspoke:0xusdt:Mega',
        '1:0xspoke:0xusde:Core',
        '1:0xspoke:0xusde:Mega',
        '1:0xotherspoke:0xusde:Core',
      ]);
      const offsetTokenAddress = '0xusde';
      const result = resolveOffsetReserveIdsV4(oppReserveId, offsetTokenAddress, reserveIdSet);
      assert.deepEqual(result.sort(), ['1:0xspoke:0xusde:Core', '1:0xspoke:0xusde:Mega'].sort());
    });

    it('cross-spoke same token does NOT match', () => {
      const oppReserveId = '1:0xspokeA:0xusdt:Core';
      const reserveIdSet = new Set([
        '1:0xspokeA:0xusdt:Core',
        '1:0xspokeB:0xusde:Core',
        '1:0xspokeA:0xusde:Core',
      ]);
      const offsetTokenAddress = '0xusde';
      const result = resolveOffsetReserveIdsV4(oppReserveId, offsetTokenAddress, reserveIdSet);
      assert.deepEqual(result, ['1:0xspokeA:0xusde:Core']);
    });
  });

  describe('extractPoolSpokePrefix', () => {
    it('V3 reserveId returns chainId:poolAddress', () => {
      assert.equal(extractPoolSpokePrefix('1:0xpool:0xtoken'), '1:0xpool');
    });

    it('V4 reserveId returns chainId:spokeAddress', () => {
      assert.equal(extractPoolSpokePrefix('1:0xspoke:0xtoken:Core'), '1:0xspoke');
    });

    it('V4 reserveId with different hub returns same spoke prefix', () => {
      assert.equal(extractPoolSpokePrefix('1:0xspoke:0xtoken:Mega'), '1:0xspoke');
    });
  });

  describe('inferVersionFromReserveId', () => {
    it('3 segments = v3', () => {
      assert.equal(inferVersionFromReserveId('1:0xpool:0xtoken'), 'v3');
    });

    it('4 segments = v4', () => {
      assert.equal(inferVersionFromReserveId('1:0xspoke:0xtoken:Core'), 'v4');
    });

    it('2 segments = unknown', () => {
      assert.equal(inferVersionFromReserveId('1:0xtoken'), null);
    });
  });
});

function inferVersionFromReserveId(reserveId: string): 'v3' | 'v4' | null {
  const segments = reserveId.split(':').length;
  if (segments === 3) return 'v3';
  if (segments >= 4) return 'v4';
  return null;
}

function extractPoolSpokePrefix(reserveId: string): string | null {
  const parts = reserveId.split(':');
  if (parts.length < 3) return null;
  return `${parts[0]}:${parts[1]}`;
}

function resolveOffsetReserveId(
  oppReserveId: string,
  offsetTokenAddress: string,
  reserveIdSet: Set<string>,
): string | undefined {
  const version = inferVersionFromReserveId(oppReserveId);
  if (version !== 'v3') return undefined;
  const prefix = extractPoolSpokePrefix(oppReserveId);
  if (!prefix) return undefined;
  const candidate = `${prefix}:${offsetTokenAddress}`;
  return reserveIdSet.has(candidate) ? candidate : undefined;
}

function resolveOffsetReserveIdsV4(
  oppReserveId: string,
  offsetTokenAddress: string,
  reserveIdSet: Set<string>,
): string[] {
  const version = inferVersionFromReserveId(oppReserveId);
  if (version !== 'v4') return [];
  const prefix = extractPoolSpokePrefix(oppReserveId);
  if (!prefix) return [];
  const base = `${prefix}:${offsetTokenAddress}`;
  const results: string[] = [];
  for (const rid of reserveIdSet) {
    if (rid.startsWith(base + ':')) {
      results.push(rid);
    }
  }
  return results;
}
