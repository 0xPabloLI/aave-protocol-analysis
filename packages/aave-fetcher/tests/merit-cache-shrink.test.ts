import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shrinkCampaignMetadataCache } from "../src/merit-api.js";

const makeEntry = (key: string) => ({
  link: `https://merit.example/${key}`,
  startDate: "2025-01-01",
  endDate: "2025-12-31",
  name: key,
});

describe("shrinkCampaignMetadataCache", () => {
  it("removes stale keys not in current APR response", () => {
    const cache: Record<string, any> = {
      "ethereum-supply-usdc": makeEntry("ethereum-supply-usdc"),
      "arbitrum-borrow-weth": makeEntry("arbitrum-borrow-weth"),
      "polygon-supply-dai": makeEntry("polygon-supply-dai"),
    };
    const activeKeys = ["ethereum-supply-usdc", "arbitrum-borrow-weth"];
    const { removed } = shrinkCampaignMetadataCache(cache, activeKeys);
    assert.equal(removed, 1);
    assert.deepEqual(Object.keys(cache).sort(), [
      "arbitrum-borrow-weth",
      "ethereum-supply-usdc",
    ]);
  });

  it("keeps self- prefix baseKey when self- key is in active set", () => {
    const cache: Record<string, any> = {
      "ethereum-supply-usdc": makeEntry("ethereum-supply-usdc"),
      "optimism-borrow-weth": makeEntry("optimism-borrow-weth"),
    };
    const activeKeys = ["ethereum-supply-usdc", "self-ethereum-supply-usdc"];
    const { removed } = shrinkCampaignMetadataCache(cache, activeKeys);
    assert.equal(removed, 1);
    assert.deepEqual(Object.keys(cache), ["ethereum-supply-usdc"]);
  });

  it("does nothing when all cached keys are active", () => {
    const cache: Record<string, any> = {
      "ethereum-supply-usdc": makeEntry("ethereum-supply-usdc"),
    };
    const activeKeys = ["ethereum-supply-usdc"];
    const { removed } = shrinkCampaignMetadataCache(cache, activeKeys);
    assert.equal(removed, 0);
    assert.ok("ethereum-supply-usdc" in cache);
  });

  it("handles empty cache", () => {
    const cache: Record<string, any> = {};
    const { removed } = shrinkCampaignMetadataCache(cache, ["ethereum-supply-usdc"]);
    assert.equal(removed, 0);
  });

  it("handles empty active keys (clears all)", () => {
    const cache: Record<string, any> = {
      "ethereum-supply-usdc": makeEntry("ethereum-supply-usdc"),
    };
    const { removed } = shrinkCampaignMetadataCache(cache, []);
    assert.equal(removed, 1);
    assert.equal(Object.keys(cache).length, 0);
  });

  it("enforces max entries by removing oldest keys (FIFO)", () => {
    const cache: Record<string, any> = {};
    const keys: string[] = [];
    for (let i = 0; i < 502; i++) {
      const key = `chain-supply-token${i}`;
      cache[key] = makeEntry(key);
      keys.push(key);
    }
    const { removed } = shrinkCampaignMetadataCache(cache, keys);
    assert.ok(removed >= 2, `expected at least 2 overflow removed, got ${removed}`);
    assert.ok(
      Object.keys(cache).length <= 500,
      `expected at most 500 entries after shrink, got ${Object.keys(cache).length}`
    );
    assert.ok(!("chain-supply-token0" in cache), "oldest key token0 should be evicted");
    assert.ok(!("chain-supply-token1" in cache), "second-oldest key token1 should be evicted");
    assert.ok("chain-supply-token501" in cache, "newest key token501 should be retained");
  });
});
