import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { createMetaRouter } from "../src/routes/meta.js";
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
        borrowableReserves: [WETH],
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

function appWith(source: () => { payload: MarketsPayload | null }) {
  const app = express();
  app.use("/api/meta", createMetaRouter({ getEModeSource: source }));
  return app;
}

describe("AAV-1394 eMode routes", () => {
  it("returns the market index with category counts", async () => {
    const app = appWith(() => ({
      payload: payload([
        market({
          marketKey: `42161:${POOL_B}`,
          chainId: 42161,
          chainName: "Arbitrum",
          marketName: "AaveV3Arbitrum",
          categories: [],
        }),
        market(),
      ]),
    }));

    const res = await request(app).get("/api/meta/e-mode").expect(200);
    assert.deepEqual(res.body, {
      generatedAt: "2026-11-17T05:00:00.000Z",
      markets: [
        {
          marketKey: `1:${POOL}`,
          chainId: 1,
          chainName: "Ethereum",
          marketName: "AaveV3Ethereum",
          categoryCount: 1,
        },
        {
          marketKey: `42161:${POOL_B}`,
          chainId: 42161,
          chainName: "Arbitrum",
          marketName: "AaveV3Arbitrum",
          categoryCount: 0,
        },
      ],
    });
  });

  it("returns one market's categories and matches an uppercase key", async () => {
    const app = appWith(() => ({ payload: payload([market()]) }));

    const res = await request(app)
      .get(`/api/meta/e-mode/1:${POOL.toUpperCase()}`)
      .expect(200);

    assert.equal(res.body.marketKey, `1:${POOL}`);
    assert.equal(res.body.marketName, "AaveV3Ethereum");
    assert.equal(res.body.generatedAt, "2026-11-17T05:00:00.000Z");
    assert.deepEqual(res.body.categories, market().categories);
  });

  it("returns 200 with empty categories for a market that has none", async () => {
    const app = appWith(() => ({
      payload: payload([market({ categories: [] })]),
    }));

    const res = await request(app)
      .get(`/api/meta/e-mode/1:${POOL}`)
      .expect(200);
    assert.deepEqual(res.body.categories, []);
  });

  it("rejects malformed market keys with 400", async () => {
    const app = appWith(() => ({ payload: payload([market()]) }));
    for (const key of ["foo", "1:", "1:0x123", "0:" + POOL]) {
      const res = await request(app).get(`/api/meta/e-mode/${key}`).expect(400);
      assert.equal(res.body.errorCode, "EMODE_INVALID_MARKET_KEY");
    }
  });

  it("returns 404 for a valid but unknown market key", async () => {
    const app = appWith(() => ({ payload: payload([market()]) }));

    const res = await request(app)
      .get(`/api/meta/e-mode/1:${POOL_B}`)
      .expect(404);
    assert.equal(res.body.errorCode, "EMODE_MARKET_NOT_FOUND");
  });

  it("returns 503 with Retry-After when the snapshot is cold", async () => {
    const app = appWith(() => ({ payload: null }));

    const res = await request(app).get("/api/meta/e-mode").expect(503);
    assert.equal(res.body.errorCode, "EMODE_SNAPSHOT_NOT_READY");
    assert.equal(res.headers["retry-after"], "10");
  });

  it("returns 503 with Retry-After when eMode data is undefined", async () => {
    const app = appWith(() => ({ payload: payload(undefined) }));

    const res = await request(app).get("/api/meta/e-mode").expect(503);
    assert.equal(res.body.errorCode, "EMODE_DATA_UNAVAILABLE");
    assert.equal(res.headers["retry-after"], "15");
  });

  it("does not leak the internal eMode array into the index response", async () => {
    const app = appWith(() => ({ payload: payload([market()]) }));

    const res = await request(app).get("/api/meta/e-mode").expect(200);
    assert.deepEqual(Object.keys(res.body).sort(), ["generatedAt", "markets"]);
  });
});
