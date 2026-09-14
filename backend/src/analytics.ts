import { logger } from "./logger.js";
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

function getAnalyticsLogger(): winston.Logger {
  if (!analyticsLogger) {
    analyticsLogger = winston.createLogger({
      level: "info",
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, message, ...meta }) =>
          JSON.stringify({
            ts: timestamp,
            ...(meta as object),
            ...(typeof message === "object"
              ? (message as object)
              : { message }),
          })
        )
      ),
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
