import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import compression from "compression";
import request from "supertest";
import { createMetaRouter } from "../src/routes/meta.js";
import { apiCacheHeadersMiddleware } from "../src/middleware/cacheHeaders.js";
import type { SideDataMetaDeps } from "../src/controllers/metaController.js";

const SIDE_DATA_CACHE_CONTROL =
  "public, max-age=60, s-maxage=600, stale-while-revalidate=600";
const ETAG_RE = /^W\/"[0-9a-f]{32}"$/;

const CATEGORIES = {
  uniqueSymbolsStablecoins: ["USDC", "USDT"],
  uniqueSymbolsEth: ["ETH", "WETH"],
};
const FDV_ITEMS = [
  {
    id: "aave",
    symbol: "AAVE",
    name: "Aave",
    fdvUsd: 3_000_000_000,
    source: "coingecko_fallback" as const,
  },
  {
    id: "uniswap",
    symbol: "UNI",
    name: "Uniswap",
    fdvUsd: 6_000_000_000,
    source: "coingecko_fallback" as const,
  },
];
const FORECAST_ITEMS = [
  {
    campaignId: "9001",
    requiredDaily: 12,
    distributedSoFar: 40,
    endTimestamp: 1_800_000_000,
  },
];

function deps(overrides: SideDataMetaDeps = {}): SideDataMetaDeps {
  return {
    getCategories: async () => ({
      data: CATEGORIES,
      fetchedAt: "2026-11-17T12:00:00.000Z",
      staleTimeMs: 21_600_000,
    }),
    getFdv: async () => ({
      data: { items: FDV_ITEMS, fetchedAt: "2026-11-17T13:50:00.000Z" },
      staleTimeMs: 900_000,
    }),
    getForecast: async () => ({
      items: FORECAST_ITEMS,
      errors: [],
      staleTimeMs: 600_000,
    }),
    getCampaignAccess: () => ({
      campaigns: {
        "1001": { chainId: 1, whitelist: ["0xabc"], blacklist: [] },
      },
      updatedAt: "2026-11-17T13:59:00.000Z",
    }),
    ...overrides,
  };
}

function appWith(sideData: SideDataMetaDeps) {
  const app = express();
  app.use(apiCacheHeadersMiddleware);
  app.use(compression({ threshold: 0 }));
  app.use("/api/meta", createMetaRouter({ sideData }));
  return app;
}

async function firstETag(sideData: SideDataMetaDeps): Promise<string> {
  const res = await request(appWith(sideData)).get("/api/meta/side-data");
  assert.equal(res.status, 200);
  const etag = res.headers.etag;
  assert.match(etag, ETAG_RE);
  return etag;
}

describe("AAV-365 GET /api/meta/side-data conditional requests", () => {
  it("S1 200 carries a weak ETag and keeps the side-data Cache-Control", async () => {
    const res = await request(appWith(deps())).get("/api/meta/side-data");
    assert.equal(res.status, 200);
    assert.match(res.headers.etag, ETAG_RE);
    assert.equal(res.headers["cache-control"], SIDE_DATA_CACHE_CONTROL);
    assert.equal(res.body.generatedAt !== undefined, true);
  });

  it("S2+S3 a second request with the same content and a later generatedAt is a 304", async () => {
    let tick = 0;
    const sideData = deps({
      now: () => new Date(1_767_000_000_000 + tick++ * 5_000),
    });
    const etag = await firstETag(sideData);
    const res = await request(appWith(sideData))
      .get("/api/meta/side-data")
      .set("If-None-Match", etag);
    assert.equal(res.status, 304);
    assert.equal(res.text, "");
    assert.equal(res.headers["content-type"], undefined);
    assert.equal(res.headers["content-length"], undefined);
    assert.equal(res.headers.etag, etag);
  });

  it("S4 a stale tag still revalidates to a full 200", async () => {
    const sideData = deps();
    const res = await request(appWith(sideData))
      .get("/api/meta/side-data")
      .set("If-None-Match", 'W/"00000000000000000000000000000000"');
    assert.equal(res.status, 200);
    assert.match(res.headers.etag, ETAG_RE);
    assert.equal(Array.isArray(res.body.fdv.items), true);
  });

  it("S5 a matching tag inside a list is honoured", async () => {
    const etag = await firstETag(deps());
    const res = await request(appWith(deps()))
      .get("/api/meta/side-data")
      .set("If-None-Match", `"unrelated", ${etag}`);
    assert.equal(res.status, 304);
  });

  it("S6 Cache-Control: no-cache forces a full 200 even with a matching tag", async () => {
    const etag = await firstETag(deps());
    const res = await request(appWith(deps()))
      .get("/api/meta/side-data")
      .set("If-None-Match", etag)
      .set("Cache-Control", "no-cache");
    assert.equal(res.status, 200);
    assert.equal(res.body.fdv.items.length, 2);
  });

  it("S7 a content change produces a new tag (no false 304)", async () => {
    let fdv = 3_000_000_000;
    const changed = deps({
      getFdv: async () => ({
        data: {
          items: [{ ...FDV_ITEMS[0], fdvUsd: fdv }, FDV_ITEMS[1]],
          fetchedAt: "2026-11-17T13:50:00.000Z",
        },
        staleTimeMs: 900_000,
      }),
    });
    const before = await firstETag(changed);
    fdv = 3_500_000_000;
    const res = await request(appWith(changed))
      .get("/api/meta/side-data")
      .set("If-None-Match", before);
    assert.equal(res.status, 200);
    assert.notEqual(res.headers.etag, before);
  });

  it("S8 campaignAccess.updatedAt churn alone keeps the tag stable", async () => {
    let updatedAt = "2026-11-17T13:59:00.000Z";
    const churn = deps({
      getCampaignAccess: () => ({
        campaigns: {
          "1001": { chainId: 1, whitelist: ["0xabc"], blacklist: [] },
        },
        updatedAt,
      }),
    });
    const before = await firstETag(churn);
    updatedAt = "2026-11-17T14:04:00.000Z";
    const res = await request(appWith(churn))
      .get("/api/meta/side-data")
      .set("If-None-Match", before);
    assert.equal(res.status, 304);
  });

  it("S9 all sub-sources failing is a 500 with no ETag and no 304", async () => {
    const failing = deps({
      getCategories: async () => {
        throw new Error("coingecko down");
      },
      getFdv: async () => {
        throw new Error("fdv down");
      },
      getForecast: async () => {
        throw new Error("forecast down");
      },
      getCampaignAccess: () => null,
    });
    const res = await request(appWith(failing))
      .get("/api/meta/side-data")
      .set("If-None-Match", 'W/"00000000000000000000000000000000"');
    assert.equal(res.status, 500);
    assert.equal(res.headers["cache-control"], "no-store");
    // No content-derived tag: whatever Express adds for the error body is not
    // the side-data entity tag, and `no-store` keeps it out of caches.
    assert.doesNotMatch(String(res.headers.etag ?? ""), ETAG_RE);
  });

  it("S10 partial failure is still 200 + ETag, and repeated errors are a 304", async () => {
    const partial = deps({
      getFdv: async () => {
        throw new Error("fdv down");
      },
    });
    const first = await request(appWith(partial)).get("/api/meta/side-data");
    assert.equal(first.status, 200);
    assert.equal(first.body.errors.fdv, "fdv down");
    const res = await request(appWith(partial))
      .get("/api/meta/side-data")
      .set("If-None-Match", first.headers.etag);
    assert.equal(res.status, 304);
  });

  it("S15 the tag does not depend on Accept-Encoding", async () => {
    const gzip = await request(appWith(deps()))
      .get("/api/meta/side-data")
      .set("Accept-Encoding", "gzip");
    const identity = await request(appWith(deps()))
      .get("/api/meta/side-data")
      .set("Accept-Encoding", "identity");
    assert.match(gzip.headers.etag, ETAG_RE);
    assert.equal(gzip.headers.etag, identity.headers.etag);
  });
});
