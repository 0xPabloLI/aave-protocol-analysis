/**
 * Side-data persistence service — persists categories/FDV/forecast cache
 * snapshots to PostgreSQL so that Railway service restarts can warm from DB
 * instead of hitting external APIs (CoinGecko, CoinMarketCap, Merkl).
 *
 * Design (mirrors persistenceService.ts patterns):
 * - Skipped silently when DATABASE_URL is unset (opt-in).
 * - Content-hash change detection: only writes when data actually changed.
 * - Failures only log a warning and never propagate.
 * - fire-and-forget writes (caller uses `void` prefix, never awaits).
 *
 * Each source has exactly one hash entry — the map size never exceeds 3.
 */
import { computeHash } from "./persistenceService.js";
import {
  isPersistenceEnabled,
  isPoolHealthy,
  queryWithHealthTracking,
  markPoolUnhealthy,
} from "./dbPool.js";
import { logger } from "../logger.js";
import { MERKL_TTL } from "../cacheTtl.js";

// ── Source constants ──────────────────────────────────────────────────────

export const SIDE_DATA_SOURCES = ["categories", "fdv", "forecast"] as const;
export type SideDataSource = (typeof SIDE_DATA_SOURCES)[number];

// ── Content-hash map (max 3 entries, one per source) ──────────────────────

const sideDataHashes = new Map<string, string>();

/** Exposed for tests: reset hash map (simulates process restart). */
// ts-prune-ignore-next
export function resetSideDataHashes(): void {
  sideDataHashes.clear();
}

/** Exposed for tests: get current hash map size. */
// ts-prune-ignore-next
export function getSideDataHashMapSize(): number {
  return sideDataHashes.size;
}

/**
 * Check if the data for a given source has changed since the last write.
 * Returns true if the data should be persisted (hash differs or no previous hash).
 * Returns false if data is null/undefined or hash is unchanged.
 */
export function shouldPersistSideData(
  source: SideDataSource,
  data: unknown
): boolean {
  if (data === null || data === undefined) return false;
  const newHash = computeHash([data]);
  if (sideDataHashes.get(source) === newHash) return false;
  sideDataHashes.set(source, newHash);
  return true;
}

// ── Payload types ──────────────────────────────────────────────────────────

export interface SideDataPayload {
  data: unknown;
  fetchedAt: number;
  contentHash: string;
}

export interface RestoredSideData {
  data: unknown;
  fetchedAt: number;
}

interface DbRow {
  source: string;
  data: unknown;
  fetched_at: string | Date;
  content_hash: string | null;
  created_at: string | Date;
}

// ── buildSideDataPayload ───────────────────────────────────────────────────

/**
 * Build the payload to persist for a given source.
 * For 'forecast', strips `staleTimeMs` (runtime constant, recomputed on load).
 * Returns null if data is null/undefined.
 */
export function buildSideDataPayload(
  source: SideDataSource,
  data: unknown,
  fetchedAt: number
): SideDataPayload | null {
  if (data === null || data === undefined) return null;

  let dataToStore = data;

  // For forecast, strip staleTimeMs (it's a runtime constant, not data).
  if (source === "forecast" && typeof data === "object" && data !== null) {
    const { staleTimeMs: _staleTimeMs, ...rest } = data as Record<
      string,
      unknown
    >;
    dataToStore = rest;
  }

  const contentHash = computeHash([dataToStore]);
  return { data: dataToStore, fetchedAt, contentHash };
}

// ── restoreSideDataFromPayload ─────────────────────────────────────────────

/**
 * Restore in-memory cache data from a DB payload.
 * For 'forecast', re-adds `staleTimeMs` (runtime constant from cacheTtl).
 * Returns null if the payload is null or data is missing required fields.
 */
export function restoreSideDataFromPayload(
  source: SideDataSource,
  payload: SideDataPayload | null
): RestoredSideData | null {
  if (!payload) return null;

  let data = payload.data;

  if (source === "forecast") {
    const forecastData = data as Record<string, unknown> | null;
    if (!forecastData || !Array.isArray(forecastData.items)) {
      logger.warn(
        `⚠️ Side-data restore: forecast data missing 'items' array, skipping`
      );
      return null;
    }
    // Re-add staleTimeMs (runtime constant, was stripped during persist).
    data = {
      items: forecastData.items,
      errors: Array.isArray(forecastData.errors) ? forecastData.errors : [],
      staleTimeMs: MERKL_TTL.forecastResultSoftTtlMs,
    };
  }

  return { data, fetchedAt: payload.fetchedAt };
}

// ── selectLatestSideData ───────────────────────────────────────────────────

/**
 * Given raw DB rows for a single source, return the one with the latest fetched_at.
 * Returns null if the array is empty.
 */
export function selectLatestSideData(rows: DbRow[]): SideDataPayload | null {
  if (rows.length === 0) return null;

  const sorted = [...rows].sort((a, b) => {
    const aTs = new Date(a.fetched_at).getTime();
    const bTs = new Date(b.fetched_at).getTime();
    return bTs - aTs;
  });

  const latest = sorted[0];
  return {
    data: latest.data,
    fetchedAt: new Date(latest.fetched_at).getTime(),
    contentHash: latest.content_hash ?? computeHash([latest.data]),
  };
}

// ── DB write ───────────────────────────────────────────────────────────────

const RETENTION_COUNT = 3;

/**
 * Persist a side-data snapshot to PostgreSQL.
 * Fire-and-forget — caller should use `void` prefix, never await.
 * Silently fails when DB is unavailable or data unchanged.
 */
export async function persistSideData(
  source: SideDataSource,
  data: unknown,
  fetchedAt: number
): Promise<void> {
  if (!isPersistenceEnabled() || !isPoolHealthy()) return;

  if (!shouldPersistSideData(source, data)) return;

  const payload = buildSideDataPayload(source, data, fetchedAt);
  if (!payload) return;

  try {
    const fetchedAtIso = new Date(payload.fetchedAt).toISOString();
    await queryWithHealthTracking(
      `INSERT INTO side_data_snapshots (source, data, fetched_at, content_hash)
       VALUES ($1, $2, $3, $4)`,
      [source, JSON.stringify(payload.data), fetchedAtIso, payload.contentHash]
    );
    await cleanupOldSideDataSnapshots(source);
  } catch (error) {
    markPoolUnhealthy();
    logger.warn(
      `⚠️ Failed to persist side-data (${source}): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Delete old rows for a given source, keeping only the latest RETENTION_COUNT.
 */
async function cleanupOldSideDataSnapshots(
  source: SideDataSource
): Promise<void> {
  try {
    await queryWithHealthTracking(
      `DELETE FROM side_data_snapshots
       WHERE source = $1
         AND id NOT IN (
           SELECT id FROM side_data_snapshots
           WHERE source = $1
           ORDER BY created_at DESC
           LIMIT $2
         )`,
      [source, RETENTION_COUNT]
    );
  } catch (error) {
    logger.warn(
      `⚠️ Failed to cleanup old side-data snapshots (${source}): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// ── DB read (startup warm) ─────────────────────────────────────────────────

/**
 * Load the latest snapshot for each source from PostgreSQL.
 * Called at startup after migrations, before warmup.
 * Returns a map of source → RestoredSideData, or empty map if DB unavailable.
 */
export async function warmSideDataFromDb(): Promise<
  Map<SideDataSource, RestoredSideData>
> {
  const result = new Map<SideDataSource, RestoredSideData>();

  if (!isPersistenceEnabled() || !isPoolHealthy()) return result;

  try {
    for (const source of SIDE_DATA_SOURCES) {
      try {
        const queryResult = await queryWithHealthTracking<DbRow>(
          `SELECT source, data, fetched_at, content_hash, created_at
           FROM side_data_snapshots
           WHERE source = $1
           ORDER BY created_at DESC
           LIMIT 3`,
          [source]
        );
        const payload = selectLatestSideData(queryResult.rows);
        if (!payload) {
          logger.info(
            `💾 No side-data snapshot found in DB for source '${source}'`
          );
          continue;
        }
        const restored = restoreSideDataFromPayload(source, payload);
        if (restored) {
          // Pre-fill the content hash so the first persist tick is a no-op.
          sideDataHashes.set(source, payload.contentHash);
          result.set(source, restored);
          logger.info(
            `💾 Warmed side-data from DB: source='${source}', age=${Math.round((Date.now() - restored.fetchedAt) / 1000)}s`
          );
        }
      } catch (error) {
        logger.warn(
          `⚠️ Failed to load side-data snapshot for source '${source}': ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  } catch (error) {
    markPoolUnhealthy();
    logger.warn(
      `⚠️ warmSideDataFromDb failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return result;
}
