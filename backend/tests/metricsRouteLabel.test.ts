/**
 * AAV-1337 — /metrics route label must never contain caller-controlled paths.
 *
 * Before the fix, unmatched requests (404) fell back to `req.path`, so every
 * unique scanned path (e.g. /wp-login.php) created ~11 permanent prom-client
 * series. The fix pins unmatched requests to a single constant label.
 *
 * Evidence contract: docs/plans/aav-1337-1344-codex-findings-cleanup-spec.md §3
 * (AAV-1337 S1–S4, S6).
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import {
  metricsMiddleware,
  UNMATCHED_ROUTE_LABEL,
} from "../src/middleware/metrics.js";
import { routeLabels, settle } from "./helpers/metricsTestUtils.js";

// Keep the run quiet: analytics events would otherwise append to
// backend/logs/analytics.log for every request in this file.
process.env.ANALYTICS_ENABLED = "false";

function buildApp(): express.Express {
  const app = express();
  app.use(metricsMiddleware);
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  // Mirrors routes/seo.ts: a router mounted under a prefix with a param route.
  const seoRouter = express.Router();
  seoRouter.get("/semrush/:id", (req, res) => {
    res.json({ id: req.params.id });
  });
  app.use("/api/seo", seoRouter);
  // Mirrors the rate limiter: a path-mounted middleware that answers directly
  // (no Express route is ever matched).
  app.use("/api/markets", (_req, res) => {
    res.status(429).json({ error: "Too many requests" });
  });
  // Mirrors the server's 404 catch-all.
  app.use((req, res) => {
    res.status(404).json({ error: "Not found", path: req.path });
  });
  return app;
}

test("S1: unmatched 404 uses the constant label, never the request path", async () => {
  const app = buildApp();
  const res = await request(app).get("/wp-login.php");
  assert.equal(res.status, 404);
  await settle();

  const labels = await routeLabels();
  assert.ok(
    labels.has(UNMATCHED_ROUTE_LABEL),
    `expected label ${UNMATCHED_ROUTE_LABEL} in ${JSON.stringify([...labels])}`
  );
  assert.ok(
    !labels.has("/wp-login.php"),
    "raw request path must never become a metric label"
  );
});

test("S2: two different unmatched paths produce exactly one new label", async () => {
  const app = buildApp();
  const before = await routeLabels();

  await request(app).get("/wp-login.php");
  await request(app).get("/xmlrpc.php");
  await settle();

  const after = await routeLabels();
  assert.equal(
    after.size,
    before.size,
    `no new label may appear for new unmatched paths, added ${JSON.stringify(
      [...after].filter((label) => !before.has(label))
    )}`
  );
  assert.ok(!after.has("/wp-login.php"));
  assert.ok(!after.has("/xmlrpc.php"));
  assert.ok(after.has(UNMATCHED_ROUTE_LABEL));
});

test("S3: matched route keeps its literal route path", async () => {
  const app = buildApp();
  const res = await request(app).get("/health");
  assert.equal(res.status, 200);
  await settle();

  const labels = await routeLabels();
  assert.ok(labels.has("/health"), "matched routes keep req.route.path");
});

test("S4: parameterized route normalizes, label never contains the raw id", async () => {
  const app = buildApp();
  await request(app).get("/api/seo/semrush/addr-0xDEADBEEF");
  await request(app).get("/api/seo/semrush/addr-0xFEEDFACE");
  await settle();

  const labels = await routeLabels();
  const added = [...labels].filter((label) => label.includes("semrush"));
  assert.equal(
    added.length,
    1,
    `two ids must collapse into one label, got ${JSON.stringify(added)}`
  );
  assert.ok(!added[0].includes("0xDEADBEEF"));
  assert.ok(!added[0].includes("0xFEEDFACE"));
});

test("S6: middleware-generated 429 uses the constant label (accepted trade-off)", async () => {
  const app = buildApp();
  const res = await request(app).get("/api/markets/anything/here");
  assert.equal(res.status, 429);
  await settle();

  const labels = await routeLabels();
  assert.ok(!labels.has("/anything/here"));
  assert.ok(!labels.has("/api/markets/anything/here"));
  assert.ok(labels.has(UNMATCHED_ROUTE_LABEL));
});
