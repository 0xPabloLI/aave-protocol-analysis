import test from 'node:test';
import assert from 'node:assert/strict';

import {
  merklBreakdownUsesPointsIntensityFields,
  merklPointsFieldsFromBreakdownValue,
  extractRewardTokenFields,
  type MerklOpportunity,
} from '../src/merkl-api.js';

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

test('merklBreakdownUsesPointsIntensityFields is true for PRETGE and POINT', () => {
  assert.equal(merklBreakdownUsesPointsIntensityFields({ token: { type: 'PRETGE' } }), true);
  assert.equal(merklBreakdownUsesPointsIntensityFields({ token: { type: 'POINT' } }), true);
  assert.equal(merklBreakdownUsesPointsIntensityFields({ token: { type: 'point' } }), true);
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

test('merklPointsFieldsFromBreakdownValue multiplies by targetTokenPrice for AMOUNT_PER_AMOUNT', () => {
  const tvl = 5_184_674;
  const value = 947_282;
  const targetTokenPrice = 0.036;
  const out = merklPointsFieldsFromBreakdownValue(
    oppWithTvl(tvl),
    { value },
    { distributionType: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT', targetTokenPrice }
  );
  assert.ok(out);
  const expected = (value / tvl) * 1000 * targetTokenPrice;
  assert.ok(Math.abs(out!.pointsPerThousandUsd - expected) < 1e-6);
});

test('merklPointsFieldsFromBreakdownValue returns 0 for AMOUNT_PER_AMOUNT without targetTokenPrice', () => {
  const out = merklPointsFieldsFromBreakdownValue(
    oppWithTvl(1_000_000),
    { value: 500 },
    { distributionType: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT' }
  );
  assert.ok(out);
  assert.equal(out!.pointsPerThousandUsd, 0);
});

test('merklPointsFieldsFromBreakdownValue does not multiply for AMOUNT_PER_VALUE', () => {
  const tvl = 23_711_444.51;
  const value = 11_312;
  const out = merklPointsFieldsFromBreakdownValue(
    oppWithTvl(tvl),
    { value },
    { distributionType: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE', targetTokenPrice: 0.036 }
  );
  assert.ok(out);
  assert.ok(Math.abs(out!.pointsPerThousandUsd - 0.477069) < 1e-4);
});

test('merklPointsFieldsFromBreakdownValue multiplies by targetTokenPrice for MAX_PER_AMOUNT', () => {
  const tvl = 100_000;
  const value = 500;
  const targetTokenPrice = 2.5;
  const out = merklPointsFieldsFromBreakdownValue(
    oppWithTvl(tvl),
    { value },
    { distributionType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT', targetTokenPrice }
  );
  assert.ok(out);
  const expected = (value / tvl) * 1000 * targetTokenPrice;
  assert.ok(Math.abs(out!.pointsPerThousandUsd - expected) < 1e-6);
});

test('merklPointsFieldsFromBreakdownValue returns undefined when campaignApr > 0', () => {
  const out = merklPointsFieldsFromBreakdownValue(
    oppWithTvl(1_000_000),
    { value: 500 },
    { campaignApr: 0.035 }
  );
  assert.equal(out, undefined);
});

test('merklPointsFieldsFromBreakdownValue returns result when campaignApr is 0', () => {
  const out = merklPointsFieldsFromBreakdownValue(
    oppWithTvl(23_711_444.51),
    { value: 11_312 },
    { campaignApr: 0 }
  );
  assert.ok(out);
  assert.ok(Math.abs(out!.pointsPerThousandUsd - 0.477069) < 1e-4);
});

test('merklPointsFieldsFromBreakdownValue returns result when campaignApr is undefined', () => {
  const out = merklPointsFieldsFromBreakdownValue(
    oppWithTvl(23_711_444.51),
    { value: 11_312 }
  );
  assert.ok(out);
  assert.ok(Math.abs(out!.pointsPerThousandUsd - 0.477069) < 1e-4);
});

test('extractRewardTokenFields returns empty when token is undefined', () => {
  assert.deepEqual(extractRewardTokenFields(undefined), {});
});

test('extractRewardTokenFields returns empty when token has no symbol or icon', () => {
  assert.deepEqual(extractRewardTokenFields({}), {});
  assert.deepEqual(extractRewardTokenFields({ type: 'TOKEN' }), {});
});

test('extractRewardTokenFields extracts symbol', () => {
  assert.deepEqual(
    extractRewardTokenFields({ symbol: 'TydroInkPoints' }),
    { rewardTokenSymbol: 'TydroInkPoints' }
  );
});

test('extractRewardTokenFields extracts icon', () => {
  assert.deepEqual(
    extractRewardTokenFields({ icon: 'https://example.com/icon.svg' }),
    { rewardTokenIconUrl: 'https://example.com/icon.svg' }
  );
});

test('extractRewardTokenFields extracts both symbol and icon', () => {
  assert.deepEqual(
    extractRewardTokenFields({ symbol: 'TydroInkPoints', icon: 'https://example.com/ink.svg', type: 'PRETGE' }),
    { rewardTokenSymbol: 'TydroInkPoints', rewardTokenIconUrl: 'https://example.com/ink.svg' }
  );
});

test('extractRewardTokenFields omits empty string symbol', () => {
  assert.deepEqual(extractRewardTokenFields({ symbol: '' }), {});
});

test('extractRewardTokenFields omits empty string icon', () => {
  assert.deepEqual(extractRewardTokenFields({ icon: '' }), {});
});
