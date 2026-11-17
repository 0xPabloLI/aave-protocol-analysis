/**
 * AAV-449 — `/api/markets` must not expose `spokeName`.
 *
 * `spokeName` is redundant with `marketName` for V4 (the market name already
 * carries the spoke suffix), drifts in meaning between the SDK path (`Main`)
 * and the RPC fallback path (`MAIN_SPOKE` / `unknown`), and has no consumer.
 *
 * These tests pin the absence at the serializer seam: the serializer is the
 * only exit for both paths, so a regression that re-adds the field to the
 * passthrough whitelist turns these red.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  serializeMarketsReservesForApi,
  serializeReserveForApi,
} from "../src/services/marketsApiSerialize.js";
import type { RuntimeReserveData } from "../src/services/marketsService.js";

const V4_IDENTITY = {
  hubId: "hub-id",
  hubName: "Core",
  hubAddress: "0x0000000000000000000000000000000000000001",
  spokeId: "spoke-id",
  spokeAddress: "0x0000000000000000000000000000000000000002",
} as const;

function v4Reserve(
  overrides: Partial<RuntimeReserveData> = {}
): RuntimeReserveData {
  return {
    reserveId: "AaveV4Ethereum:1:0xspoke:0xtoken",
    marketName: "AaveV4Main",
    chainName: "Ethereum",
    chainId: 1,
    tokenName: "USD Coin",
    tokenSymbol: "USDC",
    tokenAddress: "0x0000000000000000000000000000000000000003",
    ...V4_IDENTITY,
    spokeName: "Main",
    ...overrides,
  };
}

test("SDK-shaped V4 reserve no longer serializes spokeName", () => {
  const api = serializeReserveForApi(v4Reserve());
  assert.equal(
    "spokeName" in api,
    false,
    "spokeName leaked into the API payload"
  );
});

test("V3 reserve without spokeName stays unchanged", () => {
  const api = serializeReserveForApi({
    reserveId: "AaveV3Ethereum:1:0xabc",
    marketName: "AaveV3Ethereum",
    chainName: "Ethereum",
    chainId: 1,
    tokenName: "Test",
    tokenSymbol: "TST",
    tokenAddress: "0xabc",
    supplyApy: 0.04,
  });
  assert.equal("spokeName" in api, false);
  assert.equal(api.marketName, "AaveV3Ethereum");
});

test("RPC-fallback spokeName (address-book raw key) is not exposed either", () => {
  const api = serializeReserveForApi(v4Reserve({ spokeName: "MAIN_SPOKE" }));
  assert.equal("spokeName" in api, false);
});

test("unknown-spoke fallback label is not exposed either", () => {
  const api = serializeReserveForApi(v4Reserve({ spokeName: "unknown" }));
  assert.equal("spokeName" in api, false);
});

test("every reserve in a mixed batch is free of spokeName", () => {
  const api = serializeMarketsReservesForApi([
    v4Reserve(),
    v4Reserve({ spokeName: "Bluechip", marketName: "AaveV4Bluechip" }),
    v4Reserve({ spokeName: "MAIN_SPOKE" }),
    {
      reserveId: "AaveV3Ethereum:1:0xabc",
      marketName: "AaveV3Ethereum",
      chainName: "Ethereum",
      chainId: 1,
      tokenName: "Test",
      tokenSymbol: "TST",
      tokenAddress: "0xabc",
    },
  ]);

  for (const [index, reserve] of api.entries()) {
    assert.equal(
      "spokeName" in reserve,
      false,
      `reserve #${index} (${reserve.marketName}) leaked spokeName`
    );
  }
});

test("removing spokeName keeps the rest of the V4 identity intact", () => {
  const api = serializeReserveForApi(v4Reserve());
  assert.equal(api.hubId, V4_IDENTITY.hubId);
  assert.equal(api.hubName, V4_IDENTITY.hubName);
  assert.equal(api.spokeId, V4_IDENTITY.spokeId);
  assert.equal(api.marketName, "AaveV4Main");
});
