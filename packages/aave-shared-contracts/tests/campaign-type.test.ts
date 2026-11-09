import test from "node:test";
import assert from "node:assert/strict";

import { normalizeCampaignType } from "../src/campaign-type.js";
import type { NormalizeCampaignTypeInput } from "../src/campaign-type.js";

const MAX = "MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE" as const;
const MAX_AMOUNT = "MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT" as const;
const FIX = "FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE" as const;
const AMOUNT_PER_VALUE = "FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE" as const;
const AMOUNT_PER_AMOUNT = "FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT" as const;
const DUTCH = "DUTCH_AUCTION" as const;
const TTA = "TARGET_TOTAL_APR" as const;

// ============================================================
// Level 2: distributionType exact match (S1-S7)
// ============================================================

test("S1: Level 2 — MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE exact match", () => {
  assert.equal(
    normalizeCampaignType({
      distributionType: "MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE",
    }),
    MAX
  );
});

test("S2: Level 2 — MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT", () => {
  assert.equal(
    normalizeCampaignType({
      distributionType: "MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT",
    }),
    MAX_AMOUNT
  );
});

test("S3: Level 2 — FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE", () => {
  assert.equal(
    normalizeCampaignType({
      distributionType: "FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE",
    }),
    FIX
  );
});

test("S4: Level 2 — FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE", () => {
  assert.equal(
    normalizeCampaignType({
      distributionType: "FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE",
    }),
    AMOUNT_PER_VALUE
  );
});

test("S5: Level 2 — FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT", () => {
  assert.equal(
    normalizeCampaignType({
      distributionType: "FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT",
    }),
    AMOUNT_PER_AMOUNT
  );
});

test("S6: Level 2 — DUTCH_AUCTION", () => {
  assert.equal(
    normalizeCampaignType({ distributionType: "DUTCH_AUCTION" }),
    DUTCH
  );
});

test("S7: Level 2 — 7 Target Total APR subtypes map to TARGET_TOTAL_APR", () => {
  const types = [
    "AAVE_NET_APR",
    "AAVE_V4_NET_APR",
    "ERC4626_APR",
    "ERC4626_SPREAD_CAPPED",
    "ERC4626_TARGET_APR_WITH_MERKL",
    "SOFR_SPREAD_RATCHET",
    "DEEL_DISTRIBUTION",
  ];
  for (const t of types) {
    assert.equal(
      normalizeCampaignType({ distributionType: t }),
      TTA,
      `distributionType=${t} should map to TARGET_TOTAL_APR`
    );
  }
});

// ============================================================
// Level 3: targetAPR fallback (S8-S11)
// ============================================================

test("S8: Level 3 — positive number targetAPR fallback", () => {
  assert.equal(
    normalizeCampaignType({ targetAPR: 5.0 }),
    TTA,
    "positive number targetAPR should classify as TARGET_TOTAL_APR"
  );
});

test("S9: Level 3 — positive string targetAPR fallback", () => {
  assert.equal(
    normalizeCampaignType({ targetAPR: "3.5" }),
    TTA,
    "positive string targetAPR should classify as TARGET_TOTAL_APR"
  );
});

test("S10: Level 3 — unknown distributionType + targetAPR → fallback", () => {
  assert.equal(
    normalizeCampaignType({ distributionType: "UNKNOWN", targetAPR: 2.0 }),
    TTA,
    "Level 3 fallback activates when Level 2 misses"
  );
});

test("S11: Level 2 takes priority over Level 3", () => {
  assert.equal(
    normalizeCampaignType({
      distributionType: "DUTCH_AUCTION",
      targetAPR: 5.0,
    }),
    DUTCH,
    "Level 2 match should win over Level 3 fallback"
  );
  assert.equal(
    normalizeCampaignType({
      distributionType: "MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE",
      targetAPR: 5.0,
    }),
    MAX,
    "Level 2 match should win over Level 3 fallback"
  );
});

// ============================================================
// Level 3: invalid targetAPR rejection (S12-S16)
// ============================================================

test("S12: Level 3 rejects targetAPR=0", () => {
  assert.equal(
    normalizeCampaignType({ targetAPR: 0 }),
    null,
    "targetAPR=0 should not trigger Level 3"
  );
});

test("S13: Level 3 rejects negative targetAPR", () => {
  assert.equal(
    normalizeCampaignType({ targetAPR: -1 }),
    null,
    "negative targetAPR should not trigger Level 3"
  );
});

test("S14: Level 3 rejects NaN targetAPR", () => {
  assert.equal(
    normalizeCampaignType({ targetAPR: NaN }),
    null,
    "NaN targetAPR should not trigger Level 3"
  );
});

test("S15: Level 3 rejects non-numeric string targetAPR", () => {
  assert.equal(
    normalizeCampaignType({ targetAPR: "not a number" }),
    null,
    "non-numeric string targetAPR should not trigger Level 3"
  );
});

test("S16: Level 3 rejects undefined targetAPR", () => {
  assert.equal(
    normalizeCampaignType({ targetAPR: undefined }),
    null,
    "undefined targetAPR should not trigger Level 3"
  );
});

// ============================================================
// Level 1 removed: distributionMethod ignored (S17)
// ============================================================

test("S17: distributionMethod is no longer used (Level 1 removed)", () => {
  const input = {
    distributionMethod: "MAX_APR",
  } as unknown as NormalizeCampaignTypeInput;
  assert.equal(
    normalizeCampaignType(input),
    null,
    "distributionMethod should be ignored after Level 1 removal"
  );
  const input2 = {
    distributionMethod: "AAVE_NET_APR",
  } as unknown as NormalizeCampaignTypeInput;
  assert.equal(
    normalizeCampaignType(input2),
    null,
    "distributionMethod should be ignored after Level 1 removal"
  );
});

// ============================================================
// Case-insensitive + whitespace-tolerant (S18)
// ============================================================

test("S18: case-insensitive and whitespace-tolerant for distributionType", () => {
  assert.equal(
    normalizeCampaignType({ distributionType: " dutch_auction " }),
    DUTCH,
    "trimmed lowercase dutch_auction should match"
  );
  assert.equal(
    normalizeCampaignType({ distributionType: " aave_net_apr " }),
    TTA,
    "trimmed lowercase aave_net_apr should match TARGET_TOTAL_APR"
  );
});

// ============================================================
// Empty string distributionType (S19-S20)
// ============================================================

test("S19: empty string distributionType treated as absent (falls through to Level 3)", () => {
  assert.equal(
    normalizeCampaignType({ distributionType: "", targetAPR: 5.0 }),
    TTA,
    "empty distributionType should fall through to Level 3"
  );
});

test("S20: empty string distributionType with no targetAPR returns null", () => {
  assert.equal(
    normalizeCampaignType({ distributionType: "" }),
    null,
    "empty distributionType with no targetAPR should return null"
  );
});

// ============================================================
// Null / undefined / non-object inputs (S21-S25)
// ============================================================

test("S21: null input returns null", () => {
  assert.equal(normalizeCampaignType(null), null);
});

test("S22: undefined input returns null", () => {
  assert.equal(normalizeCampaignType(undefined), null);
});

test("S23: string input (non-object) returns null", () => {
  assert.equal(normalizeCampaignType("string"), null);
});

test("S24: number input (non-object) returns null", () => {
  assert.equal(normalizeCampaignType(42), null);
});

test("S25: empty object returns null", () => {
  assert.equal(normalizeCampaignType({}), null);
});

// ============================================================
// Unknown distributionType without targetAPR (S26)
// ============================================================

test("S26: unknown distributionType without targetAPR returns null", () => {
  assert.equal(
    normalizeCampaignType({ distributionType: "UNKNOWN_TYPE" }),
    null,
    "unknown distributionType with no targetAPR should return null"
  );
});
