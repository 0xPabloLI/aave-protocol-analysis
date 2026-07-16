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

test('extractConstraintMap collects netPositionConstraint from supply groups using opportunityId', () => {
  const reserves: RuntimeReserveData[] = [
    makeReserve({
      merklSupplys: [
        {
          opportunityId: '9623615825108171573',
          link: 'https://app.merkl.xyz/opportunities/9623615825108171573',
          netPositionConstraint: { sourceSide: 'supply', offsetReserveIds: ['1:0xpool:0xusdt'] },
        } as any,
      ],
    }),
  ];
  const map = extractConstraintMap(reserves);
  assert.equal(map.size, 1);
  assert.deepEqual(map.get('9623615825108171573'), { sourceSide: 'supply', offsetReserveIds: ['1:0xpool:0xusdt'] });
  assert.equal(map.get('https://app.merkl.xyz/opportunities/9623615825108171573'), undefined);
});

test('extractConstraintMap collects from borrow and hold groups too', () => {
  const reserves: RuntimeReserveData[] = [
    makeReserve({
      merklBorrows: [
        {
          opportunityId: 'opp-borrow-id',
          link: 'https://app.merkl.xyz/opportunities/opp-borrow-id',
          netPositionConstraint: { sourceSide: 'borrow', offsetReserveIds: ['1:0xpool:0xgho'] },
        } as any,
      ],
      merklHolds: [
        {
          opportunityId: 'opp-hold-id',
          link: 'https://app.merkl.xyz/opportunities/opp-hold-id',
          netPositionConstraint: { sourceSide: 'supply', offsetReserveIds: ['1:0xpool:0xusde'] },
        } as any,
      ],
    }),
  ];
  const map = extractConstraintMap(reserves);
  assert.equal(map.size, 2);
  assert.deepEqual(map.get('opp-borrow-id'), { sourceSide: 'borrow', offsetReserveIds: ['1:0xpool:0xgho'] });
  assert.deepEqual(map.get('opp-hold-id'), { sourceSide: 'supply', offsetReserveIds: ['1:0xpool:0xusde'] });
});

test('extractConstraintMap skips groups without netPositionConstraint or opportunityId', () => {
  const reserves: RuntimeReserveData[] = [
    makeReserve({
      merklSupplys: [
        { opportunityId: 'opp-no-constraint', link: 'opp-no-constraint' } as any,
        { link: 'opp-no-id', netPositionConstraint: { sourceSide: 'supply', offsetReserveIds: [] } } as any,
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

test('extractConstraintMap key matches fetcher key format (opportunityId, not link)', () => {
  const opportunityId = '1234567890123456789';
  const reserves: RuntimeReserveData[] = [
    makeReserve({
      merklSupplys: [
        {
          opportunityId,
          link: `https://app.merkl.xyz/opportunities/${opportunityId}`,
          netPositionConstraint: { sourceSide: 'supply', offsetReserveIds: [] },
        } as any,
      ],
    }),
  ];
  const map = extractConstraintMap(reserves);
  assert.equal(map.has(opportunityId), true, 'key should be opportunityId (plain ID), not link (URL)');
  assert.equal(map.has(`https://app.merkl.xyz/opportunities/${opportunityId}`), false, 'link format should NOT be a key');
});
