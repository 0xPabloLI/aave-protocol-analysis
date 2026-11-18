/**
 * AAV-365 — deterministic entity tags for the side-data snapshot.
 *
 * Express already emits a weak ETag for every `res.json()` body, but that tag
 * hashes the *wire bytes*. `/api/meta/side-data` rewrites two fields on every
 * response / every markets tick (`generatedAt`, `campaignAccess.updatedAt`), so
 * the byte-hash changes even when nothing the client renders has changed and a
 * conditional request could never be answered with 304.
 *
 * This module hashes the semantic content instead: canonical JSON (sorted object
 * keys, array order preserved) with the two liveness markers removed. Freshness
 * fields that mark a real refetch (`fetchedAt`) and contract constants
 * (`staleTimeMs`) stay in the hash on purpose — a re-fetch is allowed to
 * invalidate a cached copy even when the values happen to be identical.
 *
 * The tag is deliberately weak (`W/"..."`): the wire representation (key order,
 * compression, the omitted markers) is not byte-identical to the hashed form,
 * while the content it identifies is.
 */

import crypto from "node:crypto";

/**
 * Fields excluded from the side-data entity tag — liveness markers only.
 * Every entry must be justified as "changes without the content changing".
 */
export const SIDE_DATA_ETAG_OMIT_PATHS = [
  "generatedAt",
  "campaignAccess.updatedAt",
] as const;

export interface CanonicalJsonOptions {
  /** Dotted paths (`campaignAccess.updatedAt`) skipped at any depth of that path. */
  omitPaths?: readonly string[];
}

/** Digest length in hex chars: 32 hex = 128 bit, ample for a per-URL tag. */
const DEFAULT_HASH_LENGTH = 32;

/**
 * Serialise a JSON-shaped value deterministically.
 *
 * Mirrors `JSON.stringify` semantics for values the API can actually emit:
 * object keys with `undefined` values disappear, array slots with `undefined`
 * become `null`. `bigint` throws, as it does in `JSON.stringify`.
 */
export function canonicalJson(
  value: unknown,
  options: CanonicalJsonOptions = {}
): string {
  return serialize(value, options.omitPaths ?? [], "");
}

function serialize(
  value: unknown,
  omitPaths: readonly string[],
  path: string
): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      // JSON.stringify maps non-finite numbers to null, matching the wire form.
      return JSON.stringify(value);
    case "undefined":
      // Only reachable for array slots / the root value; object keys are
      // filtered out before recursion.
      return "null";
    case "object":
      break;
    default:
      throw new TypeError(
        `canonicalJson: ${typeof value} is not JSON-serialisable`
      );
  }

  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      items.push(serialize(item, omitPaths, path));
    }
    return `[${items.join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const childPath = path === "" ? key : `${path}.${key}`;
    if (omitPaths.includes(childPath)) continue;
    const child = record[key];
    if (child === undefined) continue;
    parts.push(
      `${JSON.stringify(key)}:${serialize(child, omitPaths, childPath)}`
    );
  }
  return `{${parts.join(",")}}`;
}

/** Weak ETag over the canonical form of `value`. */
export function computeWeakETag(
  value: unknown,
  options: CanonicalJsonOptions & { hashLength?: number } = {}
): string {
  const json = canonicalJson(value, options);
  const digest = crypto
    .createHash("sha256")
    .update(json, "utf8")
    .digest("hex")
    .slice(0, options.hashLength ?? DEFAULT_HASH_LENGTH);
  return `W/"${digest}"`;
}

/** The entity tag for a `/api/meta/side-data` payload. */
export function computeSideDataETag(payload: unknown): string {
  return computeWeakETag(payload, { omitPaths: SIDE_DATA_ETAG_OMIT_PATHS });
}
