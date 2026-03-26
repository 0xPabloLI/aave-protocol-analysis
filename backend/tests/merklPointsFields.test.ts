import test from 'node:test';
import assert from 'node:assert/strict';

import {
  merklBreakdownUsesPointsIntensityFields,
  merklPointsFieldsFromBreakdownValue,
  type MerklOpportunity,
} from '../../src/merkl-api.ts';

function oppWithTvl(tvl: number | undefined, protocolId?: string): MerklOpportunity {
  return {
    id: 'test-opp',
    action: 'LEND',
    chainId: 1,
    rewardsRecord: { breakdowns: [] },
    tvl,
    ...(protocolId ? { protocol: { id: protocolId } } : {}),
  } as MerklOpportunity;
}

test('merklPointsFieldsFromBreakdownValue returns undefined when value is missing', () => {
  assert.equal(
    merklPointsFieldsFromBreakdownValue(oppWithTvl(1_000_000), {}),
    undefined
  );
});

test('merklPointsFieldsFromBreakdownValue returns undefined when value is not finite', () => {
  assert.equal(
    merklPointsFieldsFromBreakdownValue(oppWithTvl(1_000_000), { value: Number.NaN }),
    undefined
  );
});

test('merklPointsFieldsFromBreakdownValue scales by TVL when value is present', () => {
  const out = merklPointsFieldsFromBreakdownValue(oppWithTvl(23_711_444.51), {
    value: 11_312,
  });
  assert.ok(out);
  assert.ok(Math.abs(out!.pointsPerThousandUsd - 0.477069) < 1e-4);
});

test('merklBreakdownUsesPointsIntensityFields is true only for PRETGE', () => {
  assert.equal(merklBreakdownUsesPointsIntensityFields({ token: { type: 'PRETGE' } }), true);
  assert.equal(
    merklBreakdownUsesPointsIntensityFields({
      token: { type: 'TOKEN', symbol: 'OP', name: 'Optimism' },
    }),
    false
  );
  assert.equal(merklBreakdownUsesPointsIntensityFields({ token: {} }), false);
});

test('merklPointsFieldsFromBreakdownValue uses zero rate when TVL is zero or missing', () => {
  const outMissing = merklPointsFieldsFromBreakdownValue(oppWithTvl(undefined), {
    value: 100,
  });
  assert.ok(outMissing);
  assert.equal(outMissing!.pointsPerThousandUsd, 0);

  const outZero = merklPointsFieldsFromBreakdownValue(oppWithTvl(0), { value: 50 });
  assert.ok(outZero);
  assert.equal(outZero!.pointsPerThousandUsd, 0);
});
