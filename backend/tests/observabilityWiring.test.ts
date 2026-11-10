/**
 * AAV-1340 — Sentry request-scope tagging must not be gated by METRICS_ENABLED.
 *
 * `tagRequestScope` correlates a Sentry error with the X-Request-ID / log line
 * of the same request. It used to be registered inside the `flags.metricsEnabled`
 * branch, so turning metrics off silently dropped that correlation. Metrics and
 * request tracing are separate capabilities (AGENTS.md §Observability).
 *
 * Evidence contract: docs/plans/aav-1337-1344-codex-findings-cleanup-spec.md §3
 * (AAV-1340 S1–S5, AAV-1337 S5).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import * as Sentry from "@sentry/node";
import { requestIdMiddleware } from "../src/middleware/requestId.js";
import { registerObservabilityMiddleware } from "../src/middleware/observability.js";
import { flags } from "../src/flags.js";
import { routeLabels, settle } from "./helpers/metricsTestUtils.js";

process.env.ANALYTICS_ENABLED = "false";

function buildApp(): express.Express {
  const app = express();
  app.use(requestIdMiddleware);
  registerObservabilityMiddleware(app);
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  return app;
}

test("Sentry is dormant in this environment (no SENTRY_DSN)", () => {
  assert.equal(flags.sentryEnabled, false, "test env must run without Sentry");
});

test("S1/S3: metrics enabled — /metrics served, Sentry scope carries the request id", async () => {
  process.env.METRICS_ENABLED = "true";
  const app = buildApp();

  const health = await request(app).get("/health");
  assert.equal(health.status, 200);
  assert.ok(health.headers["x-request-id"], "X-Request-ID header is set");
  await settle();
  // Assert before the next request: every request re-tags the same scope.
  assert.equal(
    Sentry.getCurrentScope().getScopeData().tags.request_id,
    health.headers["x-request-id"],
    "Sentry scope must be tagged with the request id"
  );

  const metrics = await request(app).get("/metrics");
  assert.equal(metrics.status, 200, "metrics endpoint is served when enabled");
});

test("S2/S4: metrics disabled — Sentry scope STILL carries the request id", async () => {
  process.env.METRICS_ENABLED = "false";
  assert.equal(flags.metricsEnabled, false, "flag must reflect the env change");
  const app = buildApp();

  const health = await request(app).get("/health");
  assert.equal(health.status, 200);
  assert.ok(health.headers["x-request-id"], "X-Request-ID header is set");
  await settle();
  assert.equal(
    Sentry.getCurrentScope().getScopeData().tags.request_id,
    health.headers["x-request-id"],
    "AAV-1340: request tracing must survive METRICS_ENABLED=false"
  );

  const metrics = await request(app).get("/metrics");
  assert.equal(
    metrics.status,
    404,
    "metrics endpoint is not served when disabled"
  );
});

test("AAV-1337 S5: metrics disabled — no metric series are registered", async () => {
  process.env.METRICS_ENABLED = "false";
  const app = buildApp();
  const before = await routeLabels();

  await request(app).get("/wp-login.php");
  await request(app).get("/health");
  await settle();

  const after = await routeLabels();
  assert.deepEqual(
    [...after].sort(),
    [...before].sort(),
    "no new series may appear while metrics are disabled"
  );
});

test("server.ts wires the observability middleware through the tested seam", () => {
  const serverSource = readFileSync(
    new URL("../src/server.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    serverSource,
    /registerObservabilityMiddleware\(app\)/,
    "server.ts must register observability middleware via the tested function"
  );
  assert.doesNotMatch(
    serverSource,
    /tagRequestScope\(req\)/,
    "tagRequestScope must not be called inline in server.ts anymore"
  );
});

test("server.ts registers request ids before the observability middleware", () => {
  const serverSource = readFileSync(
    new URL("../src/server.ts", import.meta.url),
    "utf8"
  );
  const requestIdAt = serverSource.indexOf("app.use(requestIdMiddleware)");
  const observabilityAt = serverSource.indexOf(
    "registerObservabilityMiddleware(app)"
  );
  assert.ok(requestIdAt !== -1, "server.ts must register requestIdMiddleware");
  assert.ok(
    observabilityAt !== -1,
    "server.ts must register the observability middleware"
  );
  assert.ok(
    requestIdAt < observabilityAt,
    "requestIdMiddleware must run first — tagRequestScope is a no-op without " +
      "req.requestId, so reordering silently drops the Sentry correlation"
  );
});
