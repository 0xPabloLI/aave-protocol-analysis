import { logger, scrubFormat } from "./logger.js";
import { mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import winston from "winston";

/**
 * Product/API usage analytics — local-first pipeline.
 *
 * Emits structured JSON events to `logs/analytics.log` (rotated). This is the
 * v1 self-hosted pipeline: every `trackEvent` is one JSON line queryable with
 * jq/duckdb. When a hosted product-analytics provider (PostHog/Mixpanel) is
 * adopted, only this module changes — call sites keep using `trackEvent`.
 *
 * PII boundary: callers must pass identifiers and routing facts only. The
 * current caller (`middleware/metrics.ts`) sends requestId / method / path /
 * status / durationMs — no client IP, no user agent, no wallet address. The
 * scrub gate below is defense-in-depth for the case where a caller passes
 * something it should not; it is not a licence to widen the field set. See
 * `docs/operations/pii-handling-policy.md`.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BACKEND_DIR = resolve(__dirname, "..");
const ANALYTICS_DIR = resolve(BACKEND_DIR, "logs");

try {
  mkdirSync(ANALYTICS_DIR, { recursive: true });
} catch {
  // Directory may already exist.
}

export type AnalyticsEvent =
  | "api_request"
  | "markets_snapshot_served"
  | "stale_fallback_served";

export interface AnalyticsFields {
  readonly [key: string]: unknown;
}

let analyticsLogger: winston.Logger | null = null;

/**
 * Format chain for `logs/analytics.log`.
 *
 * Exported for testing, and kept explicit because whoever adds the next event
 * field needs to see that this file is behind the shared scrub gate: a separate
 * log file is not a separate policy. Before AAV-1290 this chain had no gate at
 * all, so a field shaped like a credential (`authorization`, `apiKey`, a Bearer
 * token, a `?token=` in a URL) landed verbatim on disk.
 */
export const analyticsFormat = winston.format.combine(
  scrubFormat,
  winston.format.timestamp(),
  winston.format.printf(({ timestamp, message, ...meta }) =>
    JSON.stringify({
      ts: timestamp,
      ...(meta as object),
      ...(typeof message === "object" ? (message as object) : { message }),
    })
  )
);

/** Exported so tests can assert the transport really carries the gate. */
export function getAnalyticsLogger(): winston.Logger {
  if (!analyticsLogger) {
    analyticsLogger = winston.createLogger({
      level: "info",
      format: analyticsFormat,
      transports: [
        new winston.transports.File({
          filename: join(ANALYTICS_DIR, "analytics.log"),
          maxsize: 5242880,
          maxFiles: 3,
        }),
      ],
    });
  }
  return analyticsLogger;
}

export function trackEvent(
  event: AnalyticsEvent,
  fields: AnalyticsFields = {}
): void {
  if (process.env.ANALYTICS_ENABLED === "false") return;
  logger.debug(`analytics:${event}`, fields);
  getAnalyticsLogger().info("", { event, ...fields });
}
