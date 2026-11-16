import type { Market } from "@aave/client";
import type { Reserve as V4Reserve } from "@aave/client-v4";
import { logger } from "./logger.js";

/**
 * AAV-1379 follow-up: the V3 mapper reads `markets()` through an `any` boundary,
 * so the SDK contract was enforced by nothing but convention. A field that stops
 * being returned does not throw — every `?.` access just yields `undefined`, and
 * the mapper ships a reserve whose flags are computed off missing input.
 *
 * Two layers close that gap without touching mapper semantics:
 *
 * 1. **Compile time** — the key lists below are `satisfies`-checked against the
 *    installed SDK's fragment types. If a `@aave/client` bump drops or renames a
 *    field, `npm run build` fails on this file instead of production silently
 *    reading `undefined`. It also documents *why* key absence was never observed
 *    live: the fragment type declares these keys as required (nullable at most),
 *    so a GraphQL response can never omit them while the document matches.
 *
 * 2. **Run time** — every fetch cycle audits the payload actually received and
 *    reports what it saw. Clean cycles log one line per process (proof the audit
 *    ran against live data, not just that the file exists); a missing key logs a
 *    warning with samples on every cycle until it is fixed.
 */

/** The reserve shape the V3 mapper consumes, as declared by the installed SDK. */
export type V3Reserve = Market["supplyReserves"][number];

/** Every top-level market field `buildV3BaseDataset` reads. */
export const V3_MARKET_KEYS = [
  "address",
  "name",
  "chain",
  "supplyReserves",
] as const satisfies readonly (keyof Market)[];

/**
 * Every top-level reserve field the V3 mapper reads. Four of them decide a
 * *flag* rather than a number — `borrowInfo` (AAV-1379), `supplyInfo`,
 * `isFrozen`, `isPaused` — and for those a missing key does not degrade the
 * output, it loosens it: `undefined` reads as "not frozen / not paused /
 * supply side present / borrow side present".
 */
export const V3_RESERVE_KEYS = [
  "underlyingToken",
  "aToken",
  "vToken",
  "size",
  "supplyInfo",
  "borrowInfo",
  "isFrozen",
  "isPaused",
  "usdExchangeRate",
] as const satisfies readonly (keyof V3Reserve)[];

/**
 * Every top-level V4 reserve field the mapper reads. `canBorrow`, `canSupply`
 * and `status` carry the same hazard as their V3 counterparts: V4 defaults them
 * permissively (`canBorrow ?? true`), so absence would re-enable a disabled
 * reserve instead of failing.
 */
export const V4_RESERVE_KEYS = [
  "spoke",
  "chain",
  "asset",
  "summary",
  "settings",
  "status",
  "canBorrow",
  "canSupply",
] as const satisfies readonly (keyof V4Reserve)[];

export interface ShapeAudit {
  total: number;
  keys: readonly string[];
  /** key → number of rows where the key is absent entirely. */
  missing: Record<string, number>;
  /** key → number of rows where the key is present but `null`. */
  nullish: Record<string, number>;
  /** Up to {@link MAX_SAMPLES} human-readable rows that had at least one miss. */
  samples: string[];
  clean: boolean;
}

const MAX_SAMPLES = 5;

function readPath(value: unknown, path: readonly string[]): unknown {
  let cursor: unknown = value;
  for (const key of path) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function asText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/** `SYMBOL:address` — enough to find the reserve without trusting the payload. */
function tokenLabel(row: unknown, tokenPath: readonly string[]): string {
  const token = readPath(row, tokenPath);
  return `${asText(readPath(token, ["symbol"]), "?")}:${asText(
    readPath(token, ["address"]),
    "?"
  )}`;
}

export const v3ReserveLabel = (row: unknown): string =>
  tokenLabel(row, ["underlyingToken"]);

export const v3MarketLabel = (row: unknown): string =>
  `${asText(readPath(row, ["name"]), "?")}@${String(
    readPath(row, ["chain", "chainId"]) ?? "?"
  )}`;

export const v4ReserveLabel = (row: unknown): string =>
  tokenLabel(row, ["asset", "underlying"]);

/**
 * Counts, per key, how many rows omit it. Pure: no logging, no mutation of the
 * input, and it never throws on malformed rows (a `null` entry counts as a row
 * missing every key).
 */
export function auditShape(
  rows: readonly unknown[],
  keys: readonly string[],
  label: (row: unknown, index: number) => string = (_row, index) => `#${index}`
): ShapeAudit {
  const missing: Record<string, number> = {};
  const nullish: Record<string, number> = {};
  for (const key of keys) {
    missing[key] = 0;
    nullish[key] = 0;
  }

  const samples: string[] = [];

  rows.forEach((row, index) => {
    const record =
      typeof row === "object" && row !== null
        ? (row as Record<string, unknown>)
        : null;
    const absent: string[] = [];

    for (const key of keys) {
      // A key present with an `undefined` value is still missing as far as the
      // mapper is concerned — `reserve.borrowInfo?.x` reads the same either way.
      // GraphQL itself never emits `undefined`, so this only fires on real drift
      // or on hand-built fixtures.
      if (record === null || !(key in record) || record[key] === undefined) {
        missing[key] += 1;
        absent.push(key);
      } else if (record[key] === null) {
        nullish[key] += 1;
      }
    }

    if (absent.length > 0 && samples.length < MAX_SAMPLES) {
      samples.push(`${label(row, index)} missing ${absent.join("+")}`);
    }
  });

  return {
    total: rows.length,
    keys,
    missing,
    nullish,
    samples,
    clean: Object.values(missing).every((count) => count === 0),
  };
}

// One "shape ok" line per scope per process: enough to prove the audit ran
// against a live payload after each deploy, without one line per fetch cycle.
const reportedClean = new Set<string>();

/** Test hook — clears the once-per-process bookkeeping. */
export function resetShapeAuditReports(): void {
  reportedClean.clear();
}

export function formatShapeAudit(scope: string, audit: ShapeAudit): string {
  if (audit.clean) {
    const nulls = Object.entries(audit.nullish)
      .filter(([, count]) => count > 0)
      .map(([key, count]) => `${key}=${count}`)
      .join(", ");
    return (
      `🔎 [${scope}] reserve shape ok: ${audit.total}/${audit.total} carried ` +
      `${audit.keys.join(", ")}${nulls ? ` (present-but-null: ${nulls})` : ""}`
    );
  }

  const drift = Object.entries(audit.missing)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${key} on ${count}/${audit.total}`)
    .join(", ");

  return (
    `⚠️ [${scope}] reserve shape drift: absent ${drift}. ` +
    `The mapper reads a missing key as \`undefined\`, which loosens flags ` +
    `(not frozen / not paused / borrow or supply side present) instead of failing. ` +
    `samples: ${audit.samples.join("; ")}`
  );
}

/**
 * Logs the audit. Clean audits are announced once per process; drift is logged
 * on every call so a persistent regression cannot scroll away.
 */
export function reportShapeAudit(scope: string, audit: ShapeAudit): void {
  if (audit.total === 0) return;

  if (audit.clean) {
    if (reportedClean.has(scope)) return;
    reportedClean.add(scope);
    logger.info(formatShapeAudit(scope, audit));
    return;
  }

  logger.warn(formatShapeAudit(scope, audit));
}

/** Audit + report in one call; returns the audit for tests and callers. */
export function runShapeAudit(
  scope: string,
  rows: readonly unknown[],
  keys: readonly string[],
  label?: (row: unknown, index: number) => string
): ShapeAudit {
  const audit = auditShape(rows, keys, label);
  reportShapeAudit(scope, audit);
  return audit;
}

function collectV3Reserves(markets: readonly unknown[]): unknown[] {
  const reserves: unknown[] = [];
  for (const market of markets) {
    const list = readPath(market, ["supplyReserves"]);
    if (Array.isArray(list)) reserves.push(...list);
  }
  return reserves;
}

/**
 * Entry point for the V3 mapper: audits the market list and its flattened
 * reserves. Never mutates, never throws — a malformed payload still gets mapped
 * exactly as before, it just gets reported.
 */
export function auditV3InputShape(markets: readonly unknown[]): {
  markets: ShapeAudit;
  reserves: ShapeAudit;
} {
  return {
    markets: runShapeAudit("V3.market", markets, V3_MARKET_KEYS, v3MarketLabel),
    reserves: runShapeAudit(
      "V3.reserve",
      collectV3Reserves(markets),
      V3_RESERVE_KEYS,
      v3ReserveLabel
    ),
  };
}

/** Entry point for the V4 mapper. */
export function auditV4ReserveShape(reserves: readonly unknown[]): ShapeAudit {
  return runShapeAudit("V4.reserve", reserves, V4_RESERVE_KEYS, v4ReserveLabel);
}
