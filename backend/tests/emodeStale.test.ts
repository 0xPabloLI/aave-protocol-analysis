import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeEModeWithStale } from "../src/services/marketsService.js";
import type { EModeMarketData } from "@internal/aave-shared-contracts";

const market: EModeMarketData = {
  marketKey: "1:0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
  chainId: 1,
  chainName: "Ethereum",
  marketName: "AaveV3Ethereum",
  categories: [],
};

const HARD_TTL_MS = 6 * 60 * 60 * 1000;

describe("AAV-1394 mergeEModeWithStale", () => {
  it("replaces the stale cache when a V3 refresh produced eMode data", () => {
    const result = mergeEModeWithStale({
      freshEMode: [market],
      staleEMode: [],
      staleFetchedAt: 1,
      hardTtlMs: HARD_TTL_MS,
      now: 100,
    });

    assert.deepEqual(result, {
      eModeMarkets: [market],
      newStaleEMode: [market],
      newFetchedAt: 100,
    });
  });

  it("treats an empty fresh array as a successful result, not a miss", () => {
    const result = mergeEModeWithStale({
      freshEMode: [],
      staleEMode: [market],
      staleFetchedAt: 1,
      hardTtlMs: HARD_TTL_MS,
      now: 100,
    });

    assert.deepEqual(result.eModeMarkets, []);
    assert.deepEqual(result.newStaleEMode, []);
    assert.equal(result.newFetchedAt, 100);
  });

  it("serves stale eMode when the fresh V3 side is missing and TTL is live", () => {
    const result = mergeEModeWithStale({
      freshEMode: undefined,
      staleEMode: [market],
      staleFetchedAt: 100,
      hardTtlMs: HARD_TTL_MS,
      now: 100,
    });

    assert.deepEqual(result.eModeMarkets, [market]);
    assert.deepEqual(result.newStaleEMode, [market]);
    assert.equal(result.newFetchedAt, 100);
  });

  it("withholds stale eMode after the hard TTL expires", () => {
    const result = mergeEModeWithStale({
      freshEMode: undefined,
      staleEMode: [market],
      staleFetchedAt: 100,
      hardTtlMs: HARD_TTL_MS,
      now: 100 + HARD_TTL_MS + 1,
    });

    assert.equal(result.eModeMarkets, undefined);
    assert.deepEqual(result.newStaleEMode, [market]);
  });

  it("returns undefined when there has never been a successful eMode fetch", () => {
    const result = mergeEModeWithStale({
      freshEMode: undefined,
      staleEMode: null,
      staleFetchedAt: null,
      hardTtlMs: HARD_TTL_MS,
      now: 100,
    });

    assert.equal(result.eModeMarkets, undefined);
    assert.equal(result.newStaleEMode, null);
  });
});
