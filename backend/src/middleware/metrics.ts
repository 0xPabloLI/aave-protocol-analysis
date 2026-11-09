import type { NextFunction, Request, Response } from "express";
import client from "prom-client";
import { trackEvent } from "../analytics.js";
import { flags } from "../flags.js";

/**
 * Lightweight Prometheus metrics + API usage analytics events.
 *
 * - Default process metrics (event loop, GC, memory) under `aave_backend_` prefix
 * - HTTP request counter by method/route/status, histogram for duration
 * - Every finished request also emits a structured `api_request` analytics
 *   event (see analytics.ts) so endpoint usage is queryable from logs.
 */

// Share prom-client's global default registry — dbPool.ts (services) also
// registers its DB query histogram here without a circular import.
export const register: client.Registry = client.register;

client.collectDefaultMetrics({ register, prefix: "aave_backend_" });

const httpRequestsTotal = new client.Counter({
  name: "aave_backend_http_requests_total",
  help: "Total HTTP requests by method, route and status code",
  labelNames: ["method", "route", "status"] as const,
  registers: [register],
});

const httpRequestDuration = new client.Histogram({
  name: "aave_backend_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export function metricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const startNs = process.hrtime.bigint();
  res.on("finish", () => {
    // Normalize paths with IDs to keep label cardinality bounded
    // (e.g. /api/seo/semorphism/x -> route label stays the literal route).
    const route = req.route?.path ? String(req.route.path) : req.path;
    const durationSec = Number(process.hrtime.bigint() - startNs) / 1e9;
    try {
      httpRequestsTotal.inc({
        method: req.method,
        route,
        status: String(res.statusCode),
      });
      httpRequestDuration.observe({ method: req.method, route }, durationSec);
      if (flags.analyticsEnabled) {
        trackEvent("api_request", {
          requestId: req.requestId,
          method: req.method,
          path: route,
          status: res.statusCode,
          durationMs: Math.round(durationSec * 1000),
        });
      }
    } catch {
      // Metrics/analytics must never break the request pipeline.
    }
  });
  next();
}

export async function metricsHandler(
  _req: Request,
  res: Response
): Promise<void> {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
}
