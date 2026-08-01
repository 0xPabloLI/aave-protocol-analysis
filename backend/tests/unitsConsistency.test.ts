/**
 * Serializer ↔ Registry consistency test.
 *
 * Verifies that `serializeReserveForApi` in the backend correctly handles
 * every field according to the SERIALIZER_RULES from @internal/aave-shared-contracts.
 *
 * This test is the **runtime safety net** that catches unit mismatches:
 * if a field is declared as 'ratio' in FIELD_UNITS but the serializer
 * doesn't apply ×100, this test will fail.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { serializeReserveForApi } from "../src/services/marketsApiSerialize.js";
import type { RuntimeReserveData } from "../src/services/marketsService.js";
import {
  RATIO_FIELDS,
  PERCENT_FIELDS,
  SERIALIZER_RULES,
} from "@internal/aave-shared-contracts";

// A canonical reserve with known ratio/percent values.
// ratio fields use 0.04 (4%), percent fields use 4 (4%).
// After serialization: all should be 4 in the API output.
const RATIO_VALUE = 0.04; // 4% as ratio
const PERCENT_VALUE = 4; // 4% as percent
const EXPECTED_API_VALUE = 4; // both should produce 4 in API

function buildCanonicalReserve(): RuntimeReserveData {
  const reserve: RuntimeReserveData = {
    reserveId: "test:1:0xabc",
    marketName: "TestMarket",
    chainName: "TestChain",
    chainId: 1,
    tokenName: "TestToken",
    tokenSymbol: "TST",
    tokenAddress: "0xabc",
    tokenPrice: 1.5,
    utilizationPct: PERCENT_VALUE,
    aTokenAddress: "0xaToken",
    vTokenAddress: "0xvToken",
    supplyApy: RATIO_VALUE,
    borrowApy: RATIO_VALUE,
    protocolFee: PERCENT_VALUE,
    slopeBelowOptimal: PERCENT_VALUE,
    slopeAboveOptimal: PERCENT_VALUE,
    optimalUtilization: PERCENT_VALUE,
    baseBorrowRate: PERCENT_VALUE,
    collateralRisk: PERCENT_VALUE,
    ltv: PERCENT_VALUE,
    liquidationThreshold: PERCENT_VALUE,
    decimals: 6,
    liquidity: "1000000",
    borrowed: "500000",
    supplied: "1500000",
    supplyCap: "2000000",
    borrowCap: "1000000",
    deficit: "0",
    hubId: "hub1",
    hubName: "Hub1",
    hubAddress: "0xHub",
    spokeId: "spoke1",
    spokeName: "Spoke1",
    spokeAddress: "0xSpoke",
  };
  return reserve;
}

test("Serializer applies ×100 to all ratio fields", () => {
  const reserve = buildCanonicalReserve();
  const api = serializeReserveForApi(reserve);

  for (const field of RATIO_FIELDS) {
    const inputValue = (reserve as unknown as Record<string, unknown>)[field];
    const outputValue = (api as unknown as Record<string, unknown>)[field];
    if (inputValue !== undefined) {
      assert.equal(
        outputValue,
        EXPECTED_API_VALUE,
        `Ratio field "${field}": input ${inputValue} should serialize to ${EXPECTED_API_VALUE} (×100), got ${outputValue}`
      );
    }
  }
});

test("Serializer passes through all percent fields unchanged", () => {
  const reserve = buildCanonicalReserve();
  const api = serializeReserveForApi(reserve);

  for (const field of PERCENT_FIELDS) {
    const inputValue = (reserve as unknown as Record<string, unknown>)[field];
    const outputValue = (api as unknown as Record<string, unknown>)[field];
    if (inputValue !== undefined) {
      assert.equal(
        outputValue,
        PERCENT_VALUE,
        `Percent field "${field}": input ${inputValue} should pass through as ${PERCENT_VALUE}, got ${outputValue}`
      );
    }
  }
});

test("SERIALIZER_RULES from shared-contracts matches actual serializer behavior for ratio fields", () => {
  // This is the meta-test: for every field that SERIALIZER_RULES says 'multiply100',
  // verify the serializer actually multiplies by 100.
  const reserve = buildCanonicalReserve();
  const api = serializeReserveForApi(reserve);

  const multiply100Fields = Object.entries(SERIALIZER_RULES)
    .filter(([, rule]) => rule === "multiply100")
    .map(([field]) => field);

  for (const field of multiply100Fields) {
    // Only test fields that exist on our canonical reserve
    const inputValue = (reserve as unknown as Record<string, unknown>)[field];
    if (inputValue === undefined) continue;
    const outputValue = (api as unknown as Record<string, unknown>)[field];
    assert.notEqual(
      outputValue,
      inputValue,
      `Field "${field}" is declared 'multiply100' in SERIALIZER_RULES but serializer passed it through without scaling (input=${inputValue}, output=${outputValue})`
    );
  }
});

test("Regression: V4 RPC borrowApy must be ratio (not percent) — AAV-1106", () => {
  // Simulate a V4 RPC fallback reserve where borrowApy comes from rayToRatio.
  // If someone accidentally uses rayToPercent, borrowApy would be 4.0 (percent),
  // and the serializer would produce 400 (400%) — this test catches that.
  const reserve: RuntimeReserveData = {
    ...buildCanonicalReserve(),
    borrowApy: 0.04, // ratio = 4%
  };
  const api = serializeReserveForApi(reserve);
  assert.equal(
    api.borrowApy,
    4,
    `borrowApy 0.04 (ratio) should serialize to 4 (percent), got ${api.borrowApy}. ` +
      "If this is 400, the V4 RPC path is using rayToPercent instead of rayToRatio."
  );
});
