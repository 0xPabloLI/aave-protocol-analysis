/**
 * Feature flag registry (custom, env-backed flag system).
 *
 * Single source of truth for every runtime toggle an agent can flip without a
 * deploy code change. Rules:
 * - Every flag MUST be defined here (typed, with default) — no ad-hoc
 *   `process.env.X === "..."` checks scattered in services.
 * - Removing a flag: delete it here, then run `npm run check:feature-flags`
 *   (CI quality-gates) — it fails if the flag name is still referenced anywhere.
 * - Adding a flag: add it here, consume it via `import { flags }`, document
 *   the env var in `.env.example`.
 */

function envBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  return raw === "1" || raw.toLowerCase() === "true";
}

export interface FeatureFlags {
  /** Expose Prometheus /metrics endpoint + per-request analytics events. */
  readonly metricsEnabled: boolean;
  /** Enable Sentry error reporting (requires SENTRY_DSN to be set). */
  readonly sentryEnabled: boolean;
  /** Structured API usage analytics events (logs/analytics.log). */
  readonly analyticsEnabled: boolean;
}

export const flags: FeatureFlags = {
  get metricsEnabled() {
    return envBool("METRICS_ENABLED", true);
  },
  get sentryEnabled() {
    return envBool("SENTRY_ENABLED", true) && !!process.env.SENTRY_DSN;
  },
  get analyticsEnabled() {
    return envBool("ANALYTICS_ENABLED", true);
  },
};
