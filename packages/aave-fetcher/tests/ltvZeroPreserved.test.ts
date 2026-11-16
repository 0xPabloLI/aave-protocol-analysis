import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RuntimeReserveData } from "@internal/aave-shared-contracts";
import { buildV3BaseDataset } from "../src/concurrent-fetch.js";

/**
 * AAV-1380: `ltv = 0` on `/markets` is a real protocol value, not a missing
 * field. Governance sets base LTV to 0 for reserves that must not give base-mode
 * borrow power (stablecoins), assets with no collateral eligibility report
 * `liquidationThreshold = 0` as well, and V3.6 freeze forces `ltv -> 0` while
 * leaving the threshold untouched.
 *
 * The mapper reads `supplyInfo.maxLTV` through `percentValueToPercent`, which
 * returns `0` for `{ value: "0" }`. `0` is then kept by the `!== undefined`
 * guard. These cases pin both halves: a zero must survive, and a *missing*
 * `maxLTV` must stay missing rather than being defaulted to zero (the two are
 * different facts and the API has an assertion that every reserve carries `ltv`).
 */

function makeMarket(supplyInfo: Record<string, unknown>): unknown {
  return {
    address: "0xV3POOL",
    name: "AaveV3Market",
    chain: { name: "Ethereum", chainId: 1 },
    supplyReserves: [
      {
        underlyingToken: {
          symbol: "USDC",
          name: "USD Coin",
          address: "0xV3USDC",
          decimals: 6,
        },
        aToken: { address: "0xatoken" },
        vToken: { address: "0xvtoken" },
        isFrozen: false,
        isPaused: false,
        size: { amount: { raw: "1000000000" }, usdPerToken: "1" },
        supplyInfo,
        borrowInfo: null,
        incentives: [],
      },
    ],
  };
}

function firstReserve(markets: unknown[]): RuntimeReserveData {
  const dataset = buildV3BaseDataset(markets);
  assert.equal(dataset.length, 1, "fixture should map to exactly one reserve");
  return dataset[0];
}

function pct(value: string): { value: string } {
  return { value };
}

describe("AAV-1380 — V3 maxLTV zero must survive mapping", () => {
  it("keeps ltv === 0 (key present) when maxLTV is zero", () => {
    const reserve = firstReserve([
      makeMarket({
        apy: pct("0.02"),
        maxLTV: pct("0"),
        liquidationThreshold: pct("0.78"),
      }),
    ]);

    assert.ok(
      "ltv" in reserve,
      "ltv key must exist for a real zero — an absent key reads as 'unknown'"
    );
    assert.equal(reserve.ltv, 0);
    assert.equal(
      reserve.liquidationThreshold,
      78,
      "a zero LTV reserve can still be collateral: the threshold must survive"
    );
  });

  it("omits ltv (no zero default) when maxLTV is absent", () => {
    const reserve = firstReserve([
      makeMarket({
        apy: pct("0.02"),
        liquidationThreshold: pct("0.78"),
      }),
    ]);

    assert.ok(!("ltv" in reserve), "missing maxLTV must not be defaulted to 0");
    assert.equal(reserve.liquidationThreshold, 78);
  });

  it("maps a non-zero maxLTV to percent units (0.81 -> 81)", () => {
    const reserve = firstReserve([
      makeMarket({
        apy: pct("0.02"),
        maxLTV: pct("0.81"),
        liquidationThreshold: pct("0.84"),
      }),
    ]);

    assert.equal(reserve.ltv, 81);
    assert.equal(reserve.liquidationThreshold, 84);
  });
});
