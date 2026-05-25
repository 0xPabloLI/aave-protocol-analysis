import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IHubV4_ABI,
  ISpokeV4_ABI,
  IAaveOracle_ABI,
  IPool_ABI,
  HUB_EXTENSIONS_ABI,
  V4_ORACLE_PRICES_ABI,
  MULTICALL3_ABI,
  V4_HUB_FULL_ABI,
} from '../src/abis/index.js';

type AbiEntry = { type: string; name?: string };
type ReadonlyAbi = readonly AbiEntry[];

function fnNames(abi: ReadonlyAbi): string[] {
  return abi.filter((x) => x.type === 'function').map((x) => x.name!);
}

function hasFn(abi: ReadonlyAbi, name: string): boolean {
  return abi.some((x) => x.type === 'function' && x.name === name);
}

// ── Layer 1: Upstream re-exports ───────────────────────────

test('IHubV4_ABI has address-book methods (getAssetCount, getAsset, getSpokeCount, getSpokeAddress)', () => {
  const names = fnNames(IHubV4_ABI);
  for (const m of ['getAssetCount', 'getAsset', 'getSpokeCount', 'getSpokeAddress']) {
    assert.ok(names.includes(m), `missing ${m}`);
  }
});

test('ISpokeV4_ABI has address-book methods (getReserveCount, getReserve, ORACLE)', () => {
  const names = fnNames(ISpokeV4_ABI);
  for (const m of ['getReserveCount', 'getReserve', 'ORACLE']) {
    assert.ok(names.includes(m), `missing ${m}`);
  }
});

test('IAaveOracle_ABI has getAssetsPrices and getAssetPrice', () => {
  assert.ok(hasFn(IAaveOracle_ABI, 'getAssetsPrices'));
  assert.ok(hasFn(IAaveOracle_ABI, 'getAssetPrice'));
});


test('IPool_ABI has getReservesList and >= 60 function entries', () => {
  assert.ok(hasFn(IPool_ABI, 'getReservesList'));
  assert.ok(fnNames(IPool_ABI).length >= 60, `only ${fnNames(IPool_ABI).length} functions`);
});

// ── Layer 2: Local supplements ─────────────────────────────

test('HUB_EXTENSIONS_ABI has getSpokeDeficitRay (only)', () => {
  assert.ok(hasFn(HUB_EXTENSIONS_ABI, 'getSpokeDeficitRay'));
  assert.strictEqual(fnNames(HUB_EXTENSIONS_ABI).length, 1);
});

test('V4_ORACLE_PRICES_ABI has getReservesPrices (only)', () => {
  assert.ok(hasFn(V4_ORACLE_PRICES_ABI, 'getReservesPrices'));
  assert.strictEqual(fnNames(V4_ORACLE_PRICES_ABI).length, 1);
});

test('MULTICALL3_ABI has aggregate3 (only)', () => {
  assert.ok(hasFn(MULTICALL3_ABI, 'aggregate3'));
  assert.strictEqual(fnNames(MULTICALL3_ABI).length, 1);
});

// ── Layer 3: Merged composites ─────────────────────────────

test('V4_HUB_FULL_ABI = IHubV4 + hub-extensions', () => {
  assert.ok(hasFn(V4_HUB_FULL_ABI, 'getAssetCount'));
  assert.ok(hasFn(V4_HUB_FULL_ABI, 'getAsset'));
  assert.ok(hasFn(V4_HUB_FULL_ABI, 'getSpokeDeficitRay'));
  const baseCount = fnNames(IHubV4_ABI).length;
  const extCount = fnNames(HUB_EXTENSIONS_ABI).length;
  const fullCount = fnNames(V4_HUB_FULL_ABI).length;
  assert.strictEqual(fullCount, baseCount + extCount);
});

// ── ABI drift detection ────────────────────────────────────
// Pin minimum method counts. When address-book upgrades and
// upstream removes/renames a method, CI goes red.

const DRIFT_SPECS: Record<string, { abi: ReadonlyAbi; methods: string[]; minFnCount: number }> = {
  IHubV4:        { abi: IHubV4_ABI,       methods: ['getAssetCount', 'getAsset', 'getSpokeCount', 'getSpokeAddress'], minFnCount: 4 },
  ISpokeV4:      { abi: ISpokeV4_ABI,     methods: ['getReserveCount', 'getReserve', 'ORACLE'],                       minFnCount: 3 },
  IAaveOracle:   { abi: IAaveOracle_ABI,   methods: ['getAssetsPrices', 'getAssetPrice'],                              minFnCount: 8 },
  IPool:         { abi: IPool_ABI,         methods: ['getReservesList'],                                                minFnCount: 60 },
};

for (const [label, { abi, methods, minFnCount }] of Object.entries(DRIFT_SPECS)) {
  test(`drift: ${label} — required methods present`, () => {
    for (const m of methods) {
      assert.ok(hasFn(abi, m), `${label} missing required method: ${m}`);
    }
  });

  test(`drift: ${label} — function count >= ${minFnCount} (current: ${fnNames(abi).length})`, () => {
    assert.ok(fnNames(abi).length >= minFnCount, `${label} regressed: ${fnNames(abi).length} < ${minFnCount}`);
  });
}
