/**
 * Invariant tests for the unit conversion system.
 *
 * These tests enforce that:
 * 1. FIELD_UNITS covers every field in RuntimeReserveData (no orphans, no extras).
 * 2. SERIALIZER_RULES / RATIO_FIELDS / PERCENT_FIELDS are consistent with FIELD_UNITS.
 * 3. rayToRatio / rayToPercent / ratioToPercent / percentToRatio produce correct values.
 *
 * If you add a new field to RuntimeReserveData, you MUST add it to FIELD_UNITS
 * or this test will fail — that's the safety net.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  rayToRatio,
  rayToPercent,
  ratioToPercent,
  percentToRatio,
  FIELD_UNITS,
  SERIALIZER_RULES,
  RATIO_FIELDS,
  PERCENT_FIELDS,
  EXPECTED_RUNTIME_FIELDS,
} from "../src/index.js";

// ============================================================
// 1. Registry completeness — every RuntimeReserveData field must be in FIELD_UNITS
// ============================================================

test("FIELD_UNITS covers every field in RuntimeReserveData", () => {
  const expectedFields = EXPECTED_RUNTIME_FIELDS as readonly string[];
  const registryFields = Object.keys(FIELD_UNITS);

  const missing = expectedFields.filter((f) => !registryFields.includes(f));
  const extra = registryFields.filter((f) => !expectedFields.includes(f));

  assert.deepEqual(
    missing,
    [],
    `Fields in RuntimeReserveData but NOT in FIELD_UNITS: ${missing.join(", ")}. Add them to FIELD_UNITS in units.ts.`
  );
  assert.deepEqual(
    extra,
    [],
    `Fields in FIELD_UNITS but NOT in RuntimeReserveData: ${extra.join(", ")}. Remove them or add to EXPECTED_RUNTIME_FIELDS.`
  );
});

// ============================================================
// 2. Derived sets are consistent with FIELD_UNITS
// ============================================================

test("SERIALIZER_RULES marks all ratio fields as multiply100", () => {
  for (const field of RATIO_FIELDS) {
    assert.equal(
      SERIALIZER_RULES[field],
      "multiply100",
      `Field "${field}" is 'ratio' in FIELD_UNITS but SERIALIZER_RULES doesn't say 'multiply100'`
    );
  }
});

test("SERIALIZER_RULES marks all non-ratio fields as passthrough", () => {
  for (const [field, unit] of Object.entries(FIELD_UNITS)) {
    if (unit !== "ratio") {
      assert.equal(
        SERIALIZER_RULES[field],
        "passthrough",
        `Field "${field}" is '${unit}' in FIELD_UNITS but SERIALIZER_RULES doesn't say 'passthrough'`
      );
    }
  }
});

test("RATIO_FIELDS and PERCENT_FIELDS partition FIELD_UNITS correctly", () => {
  const allFields = Object.keys(FIELD_UNITS);
  const ratioSet = new Set(RATIO_FIELDS);
  const percentSet = new Set(PERCENT_FIELDS);

  for (const field of allFields) {
    const unit = FIELD_UNITS[field as keyof typeof FIELD_UNITS];
    if (unit === "ratio") {
      assert.ok(
        ratioSet.has(field),
        `Field "${field}" is 'ratio' but not in RATIO_FIELDS`
      );
      assert.ok(
        !percentSet.has(field),
        `Field "${field}" is 'ratio' but also in PERCENT_FIELDS`
      );
    } else if (unit === "percent") {
      assert.ok(
        percentSet.has(field),
        `Field "${field}" is 'percent' but not in PERCENT_FIELDS`
      );
      assert.ok(
        !ratioSet.has(field),
        `Field "${field}" is 'percent' but also in RATIO_FIELDS`
      );
    }
  }
});

// ============================================================
// 3. Conversion function correctness
// ============================================================

test("rayToRatio: known on-chain RAY values", () => {
  // 4% = 0.04 in ratio
  // RAY = 0.04 × 10^27 = 40000000000000000000000000
  assert.equal(rayToRatio("40000000000000000000000000"), 0.04);
  // 100% = 1.0
  assert.equal(rayToRatio("1000000000000000000000000000"), 1.0);
  // 0% = 0
  assert.equal(rayToRatio("0"), 0);
  // 2.5% = 0.025
  assert.equal(rayToRatio("25000000000000000000000000"), 0.025);
});

test("rayToRatio: edge cases", () => {
  assert.equal(rayToRatio(""), undefined);
  assert.equal(rayToRatio("not-a-number"), undefined);
  // Very small value: 1 wei = 10^-27 in ratio terms
  // rayToRatio('1') should be 0 (below 6 decimal places of precision)
  assert.equal(rayToRatio("1"), 0);
});

test("rayToPercent: known on-chain RAY values", () => {
  // 4% = 4 in percent
  assert.equal(rayToPercent("40000000000000000000000000"), 4);
  // 100% = 100
  assert.equal(rayToPercent("1000000000000000000000000000"), 100);
  // 0% = 0
  assert.equal(rayToPercent("0"), 0);
  // 2.5% = 2.5
  assert.equal(rayToPercent("25000000000000000000000000"), 2.5);
  // 5.5% = 5.5 (USDS baseBorrowRate example from AAV-1106)
  assert.equal(rayToPercent(String(BigInt(55) * 10n ** 24n)), 5.5);
  // 35% = 35 (slopeAboveOptimal example)
  assert.equal(rayToPercent(String(BigInt(35) * 10n ** 25n)), 35);
  // 0.001% = 0.001 (small fractional percent)
  assert.equal(rayToPercent(String(10n ** 22n)), 0.001);
});

test("rayToPercent: edge cases", () => {
  assert.equal(rayToPercent(""), undefined);
  assert.equal(rayToPercent("not-a-number"), undefined);
});

test("rayToRatio and rayToPercent are consistent (100× relationship)", () => {
  // rayToPercent(x) should equal rayToRatio(x) × 100
  const testValues = [
    "40000000000000000000000000", // 4%
    "25000000000000000000000000", // 2.5%
    "1000000000000000000000000000", // 100%
    "0",
  ];
  for (const ray of testValues) {
    const ratio = rayToRatio(ray);
    const pct = rayToPercent(ray);
    if (ratio !== undefined && pct !== undefined) {
      assert.ok(
        Math.abs(pct - ratio * 100) < 1e-6,
        `rayToPercent(${ray}) = ${pct} but rayToRatio(${ray}) × 100 = ${ratio * 100}`
      );
    }
  }
});

test("ratioToPercent and percentToRatio are inverses", () => {
  const testValues = [0, 0.01, 0.04, 0.5, 1.0, 4.5];
  for (const ratio of testValues) {
    const pct = ratioToPercent(ratio);
    const back = percentToRatio(pct);
    assert.ok(
      Math.abs(back - ratio) < 1e-10,
      `percentToRatio(ratioToPercent(${ratio})) = ${back}, expected ${ratio}`
    );
  }
});

// ============================================================
// 4. Critical invariant: APY fields are ratio, rate-model fields are percent
// ============================================================

test("Critical: supplyApy and borrowApy are ratio fields", () => {
  assert.equal(
    FIELD_UNITS.supplyApy,
    "ratio",
    "supplyApy MUST be ratio — serializer applies ×100"
  );
  assert.equal(
    FIELD_UNITS.borrowApy,
    "ratio",
    "borrowApy MUST be ratio — serializer applies ×100"
  );
});

test("Critical: baseBorrowRate is a percent field (not ratio)", () => {
  assert.equal(
    FIELD_UNITS.baseBorrowRate,
    "percent",
    "baseBorrowRate MUST be percent — serializer passes through"
  );
});

test("Critical: slopeBelowOptimal and optimalUtilization are percent fields", () => {
  assert.equal(FIELD_UNITS.slopeBelowOptimal, "percent");
  assert.equal(FIELD_UNITS.optimalUtilization, "percent");
});

// AAV-1222: ltv and liquidationThreshold are percent fields (passthrough, no ×100)
test("Critical: ltv and liquidationThreshold are percent fields", () => {
  assert.equal(
    FIELD_UNITS.ltv,
    "percent",
    "ltv MUST be percent — serializer passes through"
  );
  assert.equal(
    FIELD_UNITS.liquidationThreshold,
    "percent",
    "liquidationThreshold MUST be percent — serializer passes through"
  );
});
