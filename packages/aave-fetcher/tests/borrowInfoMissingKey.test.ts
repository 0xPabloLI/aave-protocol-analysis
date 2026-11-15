import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RuntimeReserveData } from "@internal/aave-shared-contracts";
import { buildV3BaseDataset } from "../src/concurrent-fetch.js";

/**
 * AAV-1379: `buildV3BaseDataset` takes `markets: any[]`, and the SDK only
 * promises that `borrowInfo` is *nullable* — not that the key always exists.
 *
 * The old predicate was `reserve.borrowInfo === null`, so a response that
 * *omitted* the key read as `isBorrowDisabledByState === false` while every
 * `borrowInfo?.x` access yielded `undefined`. The reserve then shipped as
 * "borrowable, but with no borrow-side number at all" — a shape the frontend
 * cannot interpret. These cases pin that both shapes mean "no borrow side".
 */

type BorrowInfoOverride = "missing" | null | Record<string, unknown>;

function makeMarket(
  borrowInfo: BorrowInfoOverride,
  extra: Record<string, unknown> = {}
): unknown {
  const reserve: Record<string, unknown> = {
    underlyingToken: {
      symbol: "USDC",
      name: "USD Coin",
      address: "0xv3usdc",
      decimals: 6,
    },
    aToken: { address: "0xatoken" },
    vToken: { address: "0xvtoken" },
    isFrozen: false,
    isPaused: false,
    size: {
      amount: { raw: "1000000000", value: "1000" },
      usdPerToken: "1",
    },
    supplyInfo: { apy: { value: "0.02" } },
    incentives: [],
    ...extra,
  };

  // "missing" deliberately does not assign the key at all — that is the shape
  // the ticket is about. `borrowInfo: null` is the shape the SDK sends today.
  if (borrowInfo !== "missing") {
    reserve.borrowInfo = borrowInfo;
  }

  return {
    address: "0xv3pool",
    name: "AaveV3Market",
    chain: { name: "Ethereum", chainId: 1 },
    supplyReserves: [reserve],
  };
}

const FULL_BORROW_INFO = {
  utilizationRate: { value: "0.5" },
  apy: { value: "0.03" },
  borrowingState: "ENABLED",
  availableLiquidity: { amount: { raw: "400" } },
  total: { amount: { raw: "600" } },
  borrowCap: { amount: { raw: "1000", value: "1000" } },
  reserveFactor: { value: "0.1" },
  variableRateSlope1: { value: "0.04" },
  variableRateSlope2: { value: "0.75" },
  optimalUsageRate: { value: "0.8" },
};

const BORROW_SIDE_FIELDS = [
  "utilizationPct",
  "borrowApy",
  "liquidity",
  "borrowed",
  "borrowCap",
  "protocolFee",
  "slopeBelowOptimal",
  "slopeAboveOptimal",
  "optimalUtilization",
] as const satisfies readonly (keyof RuntimeReserveData)[];

function assertNoBorrowSide(reserve: RuntimeReserveData) {
  for (const field of BORROW_SIDE_FIELDS) {
    assert.equal(
      reserve[field],
      undefined,
      `expected ${field} to stay absent, got ${String(reserve[field])}`
    );
  }
}

describe("buildV3BaseDataset — borrowInfo key omitted (AAV-1379)", () => {
  it("treats a missing key as 'no borrow side', not 'borrowable with no data'", () => {
    const [reserve] = buildV3BaseDataset([makeMarket("missing")]);

    // The regression: before the fix this was `undefined`, and the emitted
    // record claimed the reserve was borrowable while carrying no borrow data.
    assert.equal(reserve.borrowDisabled, true);
    assertNoBorrowSide(reserve);
    assert.equal(reserve.supplyApy, 0.02, "supply side is untouched");
    assert.equal(reserve.tokenSymbol, "USDC");
  });

  it("is byte-for-byte equivalent to an explicit null", () => {
    const [omitted] = buildV3BaseDataset([makeMarket("missing")]);
    const [explicitNull] = buildV3BaseDataset([makeMarket(null)]);

    assert.deepEqual(omitted, explicitNull);
  });

  it("borrowingState DISABLED keeps the numbers (a state flag is not missing data)", () => {
    const [reserve] = buildV3BaseDataset([
      makeMarket({ ...FULL_BORROW_INFO, borrowingState: "DISABLED" }),
    ]);

    assert.equal(reserve.borrowDisabled, true);
    assert.equal(reserve.utilizationPct, 50);
    assert.equal(reserve.borrowApy, 0.03);
    assert.equal(reserve.borrowed, "600");
  });

  it("a borrowable reserve is unchanged by the collapse (control)", () => {
    const [reserve] = buildV3BaseDataset([makeMarket(FULL_BORROW_INFO)]);

    assert.equal(reserve.borrowDisabled, undefined);
    assert.equal(reserve.utilizationPct, 50);
    assert.equal(reserve.borrowApy, 0.03);
    assert.equal(reserve.liquidity, "400");
    assert.equal(reserve.borrowed, "600");
    assert.equal(reserve.borrowCap, "1000");
    assert.equal(reserve.protocolFee, 10);
    assert.equal(reserve.slopeBelowOptimal, 4);
    assert.equal(reserve.slopeAboveOptimal, 75);
    assert.equal(reserve.optimalUtilization, 80);
  });

  it("borrowCap === 1 still disables borrowing when the key is present", () => {
    const [reserve] = buildV3BaseDataset([
      makeMarket({
        ...FULL_BORROW_INFO,
        borrowCap: { amount: { raw: "1", value: "1" } },
      }),
    ]);

    assert.equal(reserve.borrowDisabled, true);
  });

  it("an omitted key on a frozen reserve keeps the protocol flag, not a zeroed borrow side", () => {
    const [reserve] = buildV3BaseDataset([
      makeMarket("missing", { isFrozen: true }),
    ]);

    // Mirrors the one live record in the 441-reserve staging snapshot that has
    // no borrow-side numbers without `borrowDisabled`: Linea wrsETH, frozen.
    assert.equal(reserve.isFrozen, true);
    assert.equal(reserve.borrowDisabled, undefined);
    assertNoBorrowSide(reserve);
  });
});
