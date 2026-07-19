import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SYMBOL_EQUIV_GROUPS,
  buildEquivLookup,
  buildSymbolLookupCI,
  resolveOffsetSymbolAddress,
} from "../src/merkl-symbol-resolver.js";
import { chainSymbolKey } from "@internal/aave-shared-contracts";

// --- Test helpers ---

const makeSymbolLookup = (
  entries: [number, string, string][]
): Map<string, string> => {
  const map = new Map<string, string>();
  for (const [chainId, symbol, address] of entries) {
    map.set(chainSymbolKey(chainId, symbol), address);
  }
  return map;
};

const makeSymbolLookupCI = (
  entries: [number, string, string[]][]
): Map<string, string[]> => {
  const map = new Map<string, string[]>();
  for (const [chainId, symbol, addresses] of entries) {
    map.set(chainSymbolKey(chainId, symbol.toLowerCase()), addresses);
  }
  return map;
};

// --- Test data ---
// Real-inspired data: USDT on Ethereum, USD₮0 on Arbitrum, USD₮ on Celo
const USDE_ADDR = "0xusde";
const USDT_ADDR = "0xusdt";
const USD0_ADDR = "0xusd0"; // USD₮0 on Arbitrum
const USDCELO_ADDR = "0xusdcelo"; // USD₮ on Celo
const USDC_NATIVE = "0xusdc_native";
const USDC_BRIDGED = "0xusdc_bridged";

const symbolLookup = makeSymbolLookup([
  [1, "USDe", USDE_ADDR],
  [1, "USDT", USDT_ADDR],
  [42161, "USD₮0", USD0_ADDR],
  [42161, "USDC", USDC_NATIVE], // first-write-wins for exact
  [42220, "USD₮", USDCELO_ADDR],
]);

const symbolLookupCI = makeSymbolLookupCI([
  [1, "usde", [USDE_ADDR]],
  [1, "usdt", [USDT_ADDR]],
  [42161, "usd₮0", [USD0_ADDR]],
  [42161, "usdc", [USDC_NATIVE, USDC_BRIDGED]], // collision: native + bridged
  [42220, "usd₮", [USDCELO_ADDR]],
]);

const equivLookup = buildEquivLookup();

// --- Tests ---

describe("merkl-symbol-resolver", () => {
  describe("SYMBOL_EQUIV_GROUPS", () => {
    it("seeds USDT equivalence group with Unicode variants", () => {
      assert.deepEqual(SYMBOL_EQUIV_GROUPS, [["USDT", "USD₮0", "USD₮"]]);
    });
  });

  describe("buildEquivLookup", () => {
    it("maps each group member to a set of other members", () => {
      const lookup = buildEquivLookup();
      // sort() uses Unicode code points: T (U+0054) < ₮ (U+20AE)
      assert.deepEqual(
        [...lookup.get("USDT")!].sort(),
        ["USDT", "USD₮", "USD₮0"].filter((s) => s !== "USDT").sort()
      );
      // Simpler: just check set contents regardless of order
      assert.deepEqual(new Set(lookup.get("USDT")), new Set(["USD₮0", "USD₮"]));
      assert.deepEqual(new Set(lookup.get("USD₮0")), new Set(["USDT", "USD₮"]));
      assert.deepEqual(new Set(lookup.get("USD₮")), new Set(["USDT", "USD₮0"]));
    });

    it("registers lowercase keys for case-insensitive equiv lookup", () => {
      const lookup = buildEquivLookup();
      assert.deepEqual(new Set(lookup.get("usdt")), new Set(["USD₮0", "USD₮"]));
    });

    it("returns undefined for non-group symbol", () => {
      const lookup = buildEquivLookup();
      assert.equal(lookup.get("USDC"), undefined);
    });
  });

  describe("buildSymbolLookupCI", () => {
    it("collects ALL addresses per chainId:lower(symbol), not first-write-wins", () => {
      const reserves = [
        { chainId: 42161, tokenSymbol: "USDC", tokenAddress: USDC_NATIVE },
        { chainId: 42161, tokenSymbol: "USDC", tokenAddress: USDC_BRIDGED },
        { chainId: 1, tokenSymbol: "USDe", tokenAddress: USDE_ADDR },
      ];
      const ci = buildSymbolLookupCI(reserves);
      assert.deepEqual(ci.get(chainSymbolKey(42161, "usdc"))?.sort(), [
        USDC_BRIDGED,
        USDC_NATIVE,
      ]);
      assert.deepEqual(ci.get(chainSymbolKey(1, "usde")), [USDE_ADDR]);
    });

    it("deduplicates identical addresses", () => {
      const reserves = [
        { chainId: 1, tokenSymbol: "USDe", tokenAddress: USDE_ADDR },
        { chainId: 1, tokenSymbol: "USDe", tokenAddress: USDE_ADDR }, // same address
      ];
      const ci = buildSymbolLookupCI(reserves);
      assert.deepEqual(ci.get(chainSymbolKey(1, "usde")), [USDE_ADDR]);
    });
  });

  describe("resolveOffsetSymbolAddress", () => {
    it("1. exact match returns address (regression)", () => {
      const result = resolveOffsetSymbolAddress(
        1,
        "USDe",
        symbolLookup,
        symbolLookupCI,
        equivLookup
      );
      assert.deepEqual(result, [USDE_ADDR]);
    });

    it("2. case-insensitive recovery: usde → same address as USDe", () => {
      const result = resolveOffsetSymbolAddress(
        1,
        "usde",
        symbolLookup,
        symbolLookupCI,
        equivLookup
      );
      assert.deepEqual(result, [USDE_ADDR]);
    });

    it("2b. case-insensitive recovery: USDE → same address", () => {
      const result = resolveOffsetSymbolAddress(
        1,
        "USDE",
        symbolLookup,
        symbolLookupCI,
        equivLookup
      );
      assert.deepEqual(result, [USDE_ADDR]);
    });

    it("2c. case-insensitive recovery: Usde → same address", () => {
      const result = resolveOffsetSymbolAddress(
        1,
        "Usde",
        symbolLookup,
        symbolLookupCI,
        equivLookup
      );
      assert.deepEqual(result, [USDE_ADDR]);
    });

    it("3. exact collision returns all addresses (Arbitrum USDC)", () => {
      // symbolLookup has first-write-wins USDC_NATIVE, but CI path returns all
      const result = resolveOffsetSymbolAddress(
        42161,
        "USDC",
        symbolLookup,
        symbolLookupCI,
        equivLookup
      );
      assert.deepEqual(result.sort(), [USDC_BRIDGED, USDC_NATIVE]);
    });

    it("4. CI collision returns all addresses (usdc on Arbitrum)", () => {
      const result = resolveOffsetSymbolAddress(
        42161,
        "usdc",
        symbolLookup,
        symbolLookupCI,
        equivLookup
      );
      assert.deepEqual(result.sort(), [USDC_BRIDGED, USDC_NATIVE]);
    });

    it("5. cross-chain isolation: symbol on chain B does not resolve for chain A", () => {
      // USD₮0 only on chain 42161, not on chain 1
      const result = resolveOffsetSymbolAddress(
        1,
        "USD₮0",
        symbolLookup,
        symbolLookupCI,
        equivLookup
      );
      // equiv group: USD₮0 → try USDT (chain 1 has USDT, no USD₮0) → resolves to USDT_ADDR
      assert.deepEqual(result, [USDT_ADDR]);
    });

    it("5b. true cross-chain miss: unknown symbol on chain with no match", () => {
      const result = resolveOffsetSymbolAddress(
        999,
        "USDe",
        symbolLookup,
        symbolLookupCI,
        equivLookup
      );
      assert.deepEqual(result, []);
    });

    it("6. cross-token NOT recovered: USDC does not resolve to USDe-only market", () => {
      // Chain 1 has USDe and USDT, but no USDC. USDC is not in equiv group.
      const result = resolveOffsetSymbolAddress(
        1,
        "USDC",
        symbolLookup,
        symbolLookupCI,
        equivLookup
      );
      assert.deepEqual(result, []);
    });

    it("7. equiv group: USDT → USD₮0 (chain 42161 has USD₮0, no USDT)", () => {
      const result = resolveOffsetSymbolAddress(
        42161,
        "USDT",
        symbolLookup,
        symbolLookupCI,
        equivLookup
      );
      assert.deepEqual(result, [USD0_ADDR]);
    });

    it("8. equiv group: USD₮0 → USDT (bidirectional, chain 1 has USDT, no USD₮0)", () => {
      const result = resolveOffsetSymbolAddress(
        1,
        "USD₮0",
        symbolLookup,
        symbolLookupCI,
        equivLookup
      );
      assert.deepEqual(result, [USDT_ADDR]);
    });

    it("9. equiv group: USD₮ → USDT (bidirectional, chain 1 has USDT, no USD₮)", () => {
      const result = resolveOffsetSymbolAddress(
        1,
        "USD₮",
        symbolLookup,
        symbolLookupCI,
        equivLookup
      );
      assert.deepEqual(result, [USDT_ADDR]);
    });

    it("9b. equiv group: USDT → USD₮ (chain 42220 has USD₮, no USDT)", () => {
      const result = resolveOffsetSymbolAddress(
        42220,
        "USDT",
        symbolLookup,
        symbolLookupCI,
        equivLookup
      );
      assert.deepEqual(result, [USDCELO_ADDR]);
    });

    it("10. equiv group: no member on chain → empty array", () => {
      const result = resolveOffsetSymbolAddress(
        999,
        "USDT",
        symbolLookup,
        symbolLookupCI,
        equivLookup
      );
      assert.deepEqual(result, []);
    });

    it("11. unknown symbol → empty array", () => {
      const result = resolveOffsetSymbolAddress(
        1,
        "UNKNOWN",
        symbolLookup,
        symbolLookupCI,
        equivLookup
      );
      assert.deepEqual(result, []);
    });

    it("12. equiv group + CI compose: usdt (lowercase) on chain 42161 → resolves via equiv to USD₮0", () => {
      // CI: usdt on 42161 → no match (market has usd₮0, not usdt)
      // equiv: USDT group → try USD₮0, USD₮ → USD₮0 on 42161 → resolves
      const result = resolveOffsetSymbolAddress(
        42161,
        "usdt",
        symbolLookup,
        symbolLookupCI,
        equivLookup
      );
      assert.deepEqual(result, [USD0_ADDR]);
    });

    it("deduplicates addresses across strategies", () => {
      // If exact and CI return the same address, result should have it once
      const result = resolveOffsetSymbolAddress(
        1,
        "USDe",
        symbolLookup,
        symbolLookupCI,
        equivLookup
      );
      assert.equal(result.length, 1);
      assert.deepEqual(result, [USDE_ADDR]);
    });
  });
});
