/**
 * Shared helpers for the metrics/observability tests.
 *
 * Not a test file itself (`check:test-naming` only collects `*.test.ts`), so the
 * label-inspection helpers live in one place instead of being copy-pasted into
 * each suite that needs to assert on registered prom-client series.
 */
import { register } from "../../src/middleware/metrics.js";

const HTTP_REQUESTS_TOTAL = "aave_backend_http_requests_total";

/** `route` label values currently held by the HTTP request counter. */
export async function routeLabels(): Promise<Set<string>> {
  const metrics = await register.getMetricsAsJSON();
  const counter = metrics.find((m) => m.name === HTTP_REQUESTS_TOTAL);
  return new Set(
    (counter?.values ?? []).map((v) => String(v.labels.route ?? ""))
  );
}

/** Let the server-side `res.on("finish")` handler run before reading labels. */
export const settle = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));
