import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CrossAssetPairing } from "../dist/index.js";

describe("CrossAssetPairing", () => {
  it("should be importable from @internal/aave-shared-contracts", () => {
    const pairing: CrossAssetPairing = {
      sourceSide: "borrow",
      pairedReserveId: "8453:0xpool:0xcbETH",
      pairedSide: "supply",
      discountFactor: 0.823,
    };
    assert.strictEqual(pairing.sourceSide, "borrow");
    assert.strictEqual(pairing.pairedReserveId, "8453:0xpool:0xcbETH");
    assert.strictEqual(pairing.pairedSide, "supply");
    assert.strictEqual(pairing.discountFactor, 0.823);
  });

  it("should accept supply as sourceSide", () => {
    const pairing: CrossAssetPairing = {
      sourceSide: "supply",
      pairedReserveId: "1:0xpool:0xsUSDe",
      pairedSide: "supply",
      discountFactor: 1.196,
    };
    assert.strictEqual(pairing.sourceSide, "supply");
  });

  it("should accept borrow as pairedSide", () => {
    const pairing: CrossAssetPairing = {
      sourceSide: "supply",
      pairedReserveId: "1:0xpool:0xUSDe",
      pairedSide: "borrow",
      discountFactor: 1.0,
    };
    assert.strictEqual(pairing.pairedSide, "borrow");
  });

  it("should accept discountFactor of 0", () => {
    const pairing: CrossAssetPairing = {
      sourceSide: "borrow",
      pairedReserveId: "8453:0xpool:0xcbETH",
      pairedSide: "supply",
      discountFactor: 0,
    };
    assert.strictEqual(pairing.discountFactor, 0);
  });
});
