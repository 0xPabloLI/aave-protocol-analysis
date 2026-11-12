import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzePositionCapCopy,
  extractPositionCapFromDescription,
  isMetaMaskCampaignFamily,
} from "../src/brevis-api.js";

/**
 * The cap is scraped from Brevis frontend copy, so these cases are the contract.
 * Row 1 is the live wording (fetched 2026-11-12); the rest are the rewordings the
 * old single-regex parser would have dropped silently.
 */

test("live MetaMask copy yields 5000", () => {
  const copy =
    "Eligible MetaMask Card users —users who have completed at least one transaction using the " +
    "MetaMask Card—may earn a fixed 2.4% reward APR when lending or borrowing USDC on Aave via " +
    "Linea . This promotional rate applies to a combined total of up to 5000 USDC in collateral " +
    "and/or debt per user.";
  assert.equal(extractPositionCapFromDescription(copy), 5000);
  const analysis = analyzePositionCapCopy(copy);
  assert.equal(analysis.capUsd, 5000);
  assert.ok(analysis.pattern, "a pattern id is reported for the matched copy");
  assert.equal(analysis.hasPositionContext, true);
});

test("legacy wordings keep parsing", () => {
  assert.equal(
    extractPositionCapFromDescription("up to 5,000 USDC per user"),
    5000
  );
  assert.equal(
    extractPositionCapFromDescription("up to 10000 USD per user"),
    10000
  );
  assert.equal(extractPositionCapFromDescription("up to 1,500 USDC"), 1500);
});

test("returns null when the copy carries no cap", () => {
  assert.equal(extractPositionCapFromDescription("no cap info here"), null);
  assert.equal(extractPositionCapFromDescription(""), null);
  assert.equal(analyzePositionCapCopy("no cap info here").pattern, null);
});

test("reworded copy still parses: capped at / limited to", () => {
  assert.equal(
    extractPositionCapFromDescription(
      "Rewards are capped at $7,500 USDC per user."
    ),
    7500
  );
  assert.equal(
    extractPositionCapFromDescription(
      "Incentives are limited to 2,000 USD in collateral and debt"
    ),
    2000
  );
  assert.equal(
    extractPositionCapFromDescription(
      "A combined position cap of 12,000 USDC applies"
    ),
    12000
  );
});

test("prefers the per-user / combined figure over a smaller per-transaction one", () => {
  const copy =
    "You may earn up to 500 USDC per transaction, and a combined total of up to 5,000 USDC in " +
    "collateral and/or debt per user.";
  assert.equal(extractPositionCapFromDescription(copy), 5000);
});

test("tolerates line breaks, decimals and thousands separators", () => {
  assert.equal(
    extractPositionCapFromDescription(
      "a combined total of up to\n5,000 USDC in collateral"
    ),
    5000
  );
  assert.equal(
    extractPositionCapFromDescription("up to 5,000.50 USDC per user"),
    5000.5
  );
});

test("rejects non-caps: zero, negative and nonsense magnitudes", () => {
  assert.equal(extractPositionCapFromDescription("up to 0 USDC"), null);
  assert.equal(extractPositionCapFromDescription("up to -100 USDC"), null);
  assert.equal(
    extractPositionCapFromDescription("up to 999999999999 USDC"),
    null
  );
});

test("reports whether the match sat in position wording", () => {
  assert.equal(
    analyzePositionCapCopy("up to 5,000 USDC per user").hasPositionContext,
    true
  );
  assert.equal(
    analyzePositionCapCopy("up to 5,000 USDC of trading volume")
      .hasPositionContext,
    false
  );
});

test("only the MetaMask campaign family may inherit the scraped copy", () => {
  assert.equal(isMetaMaskCampaignFamily("MetaMask Card"), true);
  assert.equal(isMetaMaskCampaignFamily("metamask card rewards"), true);
  assert.equal(isMetaMaskCampaignFamily("Aave Boost"), false);
  assert.equal(isMetaMaskCampaignFamily(undefined), false);
  assert.equal(isMetaMaskCampaignFamily(""), false);
});
