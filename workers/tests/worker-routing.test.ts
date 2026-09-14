/**
 * Integration tests for the worker request pipeline:
 * default handler routing (health / limits / DO proxy) and the
 * BrowserPool Durable Object request contract (no real browser needed —
 * getStats and validation paths never launch Puppeteer).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DurableObjectState } from "@cloudflare/workers-types";
import worker from "../src/index.js";
import { BrowserPool, type Env } from "../src/browser-pool.js";

interface ForwardedCall {
  url: string;
  method: string;
}

function makeEnv(forwardResponse: Response) {
  const calls: ForwardedCall[] = [];
  const stub = {
    fetch: async (req: Request): Promise<Response> => {
      calls.push({ url: req.url, method: req.method });
      return forwardResponse;
    },
  };
  const env = {
    MY_BROWSER: {},
    BROWSER_POOL: {
      idFromName: (name: string) => ({ name }),
      get: () => stub,
    },
  };
  return { env: env as unknown as Env, calls };
}

describe("worker default handler routing", () => {
  it("GET /health returns 200 ok without touching the browser binding", async () => {
    const { env, calls } = makeEnv(new Response("should not forward"));
    const response = await worker.fetch(
      new Request("https://worker.test/health"),
      env
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string };
    assert.equal(body.status, "ok");
    assert.equal(calls.length, 0, "/health must not round-trip through the DO");
  });

  it("GET /limits reports failure when the browser binding is unavailable", async () => {
    const { env, calls } = makeEnv(new Response("should not forward"));
    const response = await worker.fetch(
      new Request("https://worker.test/limits"),
      env
    );
    const body = (await response.json()) as {
      success: boolean;
      error?: string;
    };
    assert.equal(
      body.success,
      false,
      "limits lookup without a real binding must fail gracefully"
    );
    assert.equal(calls.length, 0, "/limits must not round-trip through the DO");
  });

  it("proxies other paths to the global browser pool DO", async () => {
    const { env, calls } = makeEnv(new Response("from-do", { status: 418 }));
    const response = await worker.fetch(
      new Request("https://worker.test/render", { method: "POST" }),
      env
    );
    assert.equal(response.status, 418);
    assert.equal(await response.text(), "from-do");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://worker.test/render");
    assert.equal(calls[0].method, "POST");
  });
});

function poolRequest(body: unknown): Request {
  return new Request("https://worker.test/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makePool(): BrowserPool {
  return new BrowserPool(
    {} as unknown as DurableObjectState,
    {} as unknown as Env
  );
}

describe("BrowserPool Durable Object request contract", () => {
  it("rejects non-POST requests with 405", async () => {
    const pool = makePool();
    const response = await pool.fetch(new Request("https://worker.test/"));
    assert.equal(response.status, 405);
  });

  it("returns 400 when action is missing", async () => {
    const pool = makePool();
    const response = await pool.fetch(poolRequest({}));
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /Missing required fields/);
  });

  it("returns 400 when a keyed action omits key", async () => {
    const pool = makePool();
    const response = await pool.fetch(
      poolRequest({ action: "extractCampaignInfo" })
    );
    assert.equal(response.status, 400);
  });

  it("getStats returns zeroed counters without launching a browser", async () => {
    const pool = makePool();
    const response = await pool.fetch(poolRequest({ action: "getStats" }));
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      success: boolean;
      stats: Record<string, unknown>;
    };
    assert.equal(body.success, true);
    assert.equal(body.stats.browserActive, false);
    assert.equal(body.stats.totalRequests, 0);
    assert.equal(body.stats.totalLaunches, 0);
    assert.equal(body.stats.totalErrors, 0);
    assert.equal(body.stats.launchesInLastMinute, 0);
  });
});
