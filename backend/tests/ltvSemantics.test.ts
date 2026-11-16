import test from "node:test";
import assert from "node:assert/strict";
import type { RuntimeReserveData } from "@internal/aave-shared-contracts";
import { serializeReserveForApi } from "../src/services/marketsApiSerialize.js";

/**
 * AAV-1380: `ltv: 0` means "this collateral gives no base-mode borrow power"
 * (governance LTV-0, or `liquidationThreshold = 0` for a non-collateral asset).
 * It is a real value, not an empty one, so the serializer must keep it.
 *
 * The sibling contract is the opposite one: `protocolFee: 0` is *deliberately*
 * omitted ("absent means 0", AAV-1350). Both live in this function, so these
 * cases pin that the two rules stay different — a future cleanup that turns
 * every number into a truthiness check would silently drop 312 of 441 `ltv`
 * values and get caught right here.
 */

function makeReserve(
  overrides: Partial<RuntimeReserveData>
): RuntimeReserveData {
  return {
    reserveId:
      "1:0x0000000000000000000000000000000000000001:0x0000000000000000000000000000000000000002",
    marketName: "AaveV3Ethereum",
    chainName: "Ethereum",
    chainId: 1,
    tokenName: "USD Coin",
    tokenSymbol: "USDC",
    tokenAddress: "0x0000000000000000000000000000000000000002",
    ...overrides,
  };
}

test("AAV-1380 — ltv 0 is serialized, not treated as absent", () => {
  const out = serializeReserveForApi(
    makeReserve({ ltv: 0, liquidationThreshold: 0 })
  );
  assert.equal(out.ltv, 0);
  assert.ok("ltv" in out, "ltv key must exist in the API payload");
});

test("AAV-1380 — undefined ltv stays omitted (no zero default)", () => {
  const out = serializeReserveForApi(makeReserve({ liquidationThreshold: 78 }));
  assert.ok(!("ltv" in out), "undefined ltv must not become 0");
});

test("AAV-1380 — liquidationThreshold 0 survives, and 0 lt does not imply 0 ltv", () => {
  const out = serializeReserveForApi(
    makeReserve({ ltv: 0.05, liquidationThreshold: 0 })
  );
  assert.equal(out.liquidationThreshold, 0);
  assert.equal(out.ltv, 0.05);
});
