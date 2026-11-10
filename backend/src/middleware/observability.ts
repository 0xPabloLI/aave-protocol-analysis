import type { Express } from "express";
import { flags } from "../flags.js";
import { tagRequestScope } from "../instrumentation.js";
import { metricsHandler, metricsMiddleware } from "./metrics.js";

/**
 * Register the cross-cutting observability middleware on the app.
 *
 * Request tracing and metrics are separate capabilities (AGENTS.md
 * §Observability): `tagRequestScope` ties an error report to the X-Request-ID
 * of the same request, so it must run whether or not metrics are enabled.
 * It used to live inside the metrics branch, which silently dropped that
 * correlation whenever METRICS_ENABLED was false (AAV-1340).
 *
 * Must be registered after `requestIdMiddleware` — it reads `req.requestId`
 * and is a no-op without one.
 *
 * Kept in its own module (rather than inline in server.ts) so the wiring is
 * testable: server.ts has import-time side effects and cannot be imported.
 */
export function registerObservabilityMiddleware(app: Express): void {
  app.use((req, _res, next) => {
    tagRequestScope(req);
    next();
  });

  if (flags.metricsEnabled) {
    app.use(metricsMiddleware);
    app.get("/metrics", metricsHandler);
  }
}
