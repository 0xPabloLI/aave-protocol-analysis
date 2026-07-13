import test from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeReserveData, NetPositionConstraint } from '@internal/aave-shared-contracts';
import { extractConstraintMap } from '../src/services/marketsService.js';

function makeReserve(overrides: Partial<RuntimeReserveData> = {}): RuntimeReserveData {
  return {
    chainId: 1,
    marketName: 'AaveV3Ethereum',
    protocolVersion: 'v3',
    reserveId: '1:0xpool:0xusdt',
    symbol: 'USDT',
    decimals: 6,
    tokenAddress: '0xusdt',
    merklSupplys: [],
    merklBorrows: [],
    merklHolds: [],
    ...overrides,
  } as RuntimeReserveData;
}

test('extractConstraintMap collects netPositionConstraint from supply groups', () => {
  const reserves: RuntimeReserveData[] = [
    makeReserve({
      merklSupplys: [
        {
          link: 'opp-1',
          netPositionConstraint: { sourceSide: 'supply', offsetReserveIds: ['1:0xpool:0xusdt'] },
        } as any,
      ],
    }),
  ];
  const map = extractConstraintMap(reserves);
  assert.equal(map.size, 1);
  assert.deepEqual(map.get('opp-1'), { sourceSide: 'supply', offsetReserveIds: ['1:0xpool:0xusdt'] });
});

test('extractConstraintMap collects from borrow and hold groups too', () => {
  const reserves: RuntimeReserveData[] = [
    makeReserve({
      merklBorrows: [
        {
          link: 'opp-borrow',
          netPositionConstraint: { sourceSide: 'borrow', offsetReserveIds: ['1:0xpool:0xgho'] },
        } as any,
      ],
      merklHolds: [
        {
          link: 'opp-hold',
          netPositionConstraint: { sourceSide: 'supply', offsetReserveIds: ['1:0xpool:0xusde'] },
        } as any,
      ],
    }),
  ];
  const map = extractConstraintMap(reserves);
  assert.equal(map.size, 2);
  assert.deepEqual(map.get('opp-borrow'), { sourceSide: 'borrow', offsetReserveIds: ['1:0xpool:0xgho'] });
  assert.deepEqual(map.get('opp-hold'), { sourceSide: 'supply', offsetReserveIds: ['1:0xpool:0xusde'] });
});

test('extractConstraintMap skips groups without netPositionConstraint or link', () => {
  const reserves: RuntimeReserveData[] = [
    makeReserve({
      merklSupplys: [
        { link: 'opp-no-constraint' } as any,
        { netPositionConstraint: { sourceSide: 'supply', offsetReserveIds: [] } } as any,
      ],
    }),
  ];
  const map = extractConstraintMap(reserves);
  assert.equal(map.size, 0);
});

test('extractConstraintMap returns empty map for empty reserves', () => {
  const map = extractConstraintMap([]);
  assert.equal(map.size, 0);
});
