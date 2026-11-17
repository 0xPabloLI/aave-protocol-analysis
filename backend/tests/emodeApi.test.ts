import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildEModeIndex,
  findEModeMarket,
  parseEModeMarketKey,
} from "../src/services/emodeApi.js";
import type {
  EModeMarketData,
  MarketsPayload,
} from "@internal/aave-shared-contracts";

const POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2";
const POOL_B = "0x794a61358d6845594f94dc1db02a252b5b4814ad";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

function market(overrides: Partial<EModeMarketData> = {}): EModeMarketData {
  return {
    marketKey: `1:${POOL}`,
    chainId: 1,
    chainName: "Ethereum",
    marketName: "AaveV3Ethereum",
    categories: [
      {
        id: 1,
        label: "ETH correlated",
        maxLtv: 93,
        liquidationThreshold: 95,
        liquidationPenalty: 1,
        collateralReserves: [WETH],
        borrowableReserves: [],
      },
    ],
    ...overrides,
  };
}

function payload(eModeMarkets: EModeMarketData[] | undefined): MarketsPayload {
  return {
    _metadata: {
      timestamp: "2026-11-17T05:00:00.000Z",
      version: "2.0-runtime-minimal",
      dataCount: 0,
      profile: "runtime-minimal",
    },
    data: [],
    ...(eModeMarkets !== undefined ? { eModeMarkets } : {}),
  };
}

describe("AAV-1394 eMode API selectors", () => {
  it("builds a sorted market index with category counts", () => {
    const result = buildEModeIndex(
      payload([
        market({
          marketKey: `42161:${POOL_B}`,
          chainId: 42161,
          chainName: "Arbitrum",
          marketName: "AaveV3Arbitrum",
          categories: [],
        }),
        market(),
      ])
    );

    assert.equal(result.generatedAt, "2026-11-17T05:00:00.000Z");
    assert.deepEqual(
      result.markets.map((m) => [m.chainId, m.marketKey, m.categoryCount]),
      [
        [1, `1:${POOL}`, 1],
        [42161, `42161:${POOL_B}`, 0],
      ]
    );
  });

  it("returns an empty index when the V3 side produced no categories", () => {
    assert.deepEqual(buildEModeIndex(payload([])), {
      generatedAt: "2026-11-17T05:00:00.000Z",
      markets: [],
    });
  });

  it("parses and canonicalizes market keys case-insensitively", () => {
    assert.equal(parseEModeMarketKey(`1:${POOL.toUpperCase()}`), `1:${POOL}`);
    assert.equal(parseEModeMarketKey(" 1:0xABC "), null);
    assert.equal(parseEModeMarketKey("1:0x123"), null);
    assert.equal(parseEModeMarketKey("0:" + POOL), null);
    assert.equal(parseEModeMarketKey("foo"), null);
  });

  it("finds a market by canonical key only", () => {
    const data = payload([market()]);
    assert.equal(
      findEModeMarket(data, `1:${POOL}`)?.marketName,
      "AaveV3Ethereum"
    );
    assert.equal(findEModeMarket(data, `1:${POOL_B}`), undefined);
    assert.equal(findEModeMarket(payload(undefined), `1:${POOL}`), undefined);
  });
});
