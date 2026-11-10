/**
 * AAV-1339 — side-data write path against a REAL PostgreSQL.
 *
 * The default suite drives `persistSideData` through its `query` seam, which
 * proves the ordering but not the SQL. This file runs the same code against a
 * live server: `INSERT`, the `UPDATE … WHERE content_hash = $2` touch, its
 * `rowCount`, the retention `DELETE`, and `warmSideDataFromDb()` reading back
 * what was written.
 *
 * Opt-in. Set TEST_DATABASE_URL (a throwaway database — never DATABASE_URL,
 * which may point at staging). Skipped when unset.
 *
 *   docker run --rm -d --name aav1339-pg -p 55432:5432 \
 *     -e POSTGRES_PASSWORD=postgres postgres:16-alpine
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
 *     npx --no-install tsx --test tests/sideDataPersistenceDb.test.ts
 *
 * Evidence contract: docs/plans/aav-1337-1344-codex-findings-cleanup-spec.md §3
 * (AAV-1339 S1, S3, S4, S5, S9).
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SKIP_REASON = TEST_DATABASE_URL
  ? false
  : "TEST_DATABASE_URL not set (opt-in real-Postgres suite)";

if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
}

// Imported after the env override so the pool picks up the test database.
const { queryWithHealthTracking, resetPoolHealth, closePool } =
  await import("../src/services/dbPool.js");
const {
  persistSideData,
  resetSideDataHashes,
  getSideDataHashMapSize,
  buildSideDataPayload,
  warmSideDataFromDb,
} = await import("../src/services/sideDataPersistenceService.js");
const { BACKEND_CACHE_TTL_MS, COINGECKO_TTL } =
  await import("../src/cacheTtl.js");

const MIGRATION_SQL = readFileSync(
  new URL("../migrations/002_side_data_snapshots.sql", import.meta.url),
  "utf8"
);

/** Content hashes created by this run — the only rows cleanup may delete. */
const createdHashes = new Set<string>();

const CATEGORIES_A = {
  __aav1339: "categories-A",
  uniqueSymbolsStablecoins: ["USDC"],
  uniqueSymbolsEth: ["WETH"],
};
const CATEGORIES_B = {
  __aav1339: "categories-B",
  uniqueSymbolsStablecoins: ["DAI"],
  uniqueSymbolsEth: ["WETH"],
};
const FORECAST = {
  __aav1339: "forecast-A",
  items: [{ campaignId: "c1", distributedSoFar: 1, endTimestamp: 2 }],
  errors: [],
  staleTimeMs: 600_000,
};

function trackHash(source: "categories" | "forecast", data: unknown): void {
  const payload = buildSideDataPayload(source, data, 0);
  assert.ok(payload, "test fixture must produce a payload");
  createdHashes.add(payload.contentHash);
}

/**
 * Make INSERTs fail for real, without touching the table itself (a renamed or
 * dropped table would leave the schema broken if the run died mid-test).
 */
async function installBlockInsertTrigger(): Promise<void> {
  await queryWithHealthTracking(`
    CREATE OR REPLACE FUNCTION aav1339_block_insert() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'aav1339 simulated write failure'; END;
    $$ LANGUAGE plpgsql;
  `);
  await queryWithHealthTracking(`
    CREATE TRIGGER aav1339_block_insert BEFORE INSERT ON side_data_snapshots
    FOR EACH ROW EXECUTE FUNCTION aav1339_block_insert();
  `);
}

async function dropBlockInsertTrigger(): Promise<void> {
  await queryWithHealthTracking(
    `DROP TRIGGER IF EXISTS aav1339_block_insert ON side_data_snapshots`
  );
  await queryWithHealthTracking(
    `DROP FUNCTION IF EXISTS aav1339_block_insert()`
  );
}

/**
 * Remove the rows this run created for one source, so a test can assert on the
 * snapshot it just wrote without inheriting an older-but-newer-fetched_at row
 * from a sibling test. Only hashes created here are eligible.
 */
async function clearTrackedRows(source: string): Promise<void> {
  if (createdHashes.size === 0) return;
  await queryWithHealthTracking(
    `DELETE FROM side_data_snapshots WHERE source = $1 AND content_hash = ANY($2::text[])`,
    [source, [...createdHashes]]
  );
}

async function rowCount(source: string): Promise<number> {
  const res = await queryWithHealthTracking<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM side_data_snapshots WHERE source = $1`,
    [source]
  );
  return Number(res.rows[0].count);
}

async function latestRow(
  source: string
): Promise<{ fetched_at: Date; content_hash: string } | null> {
  const res = await queryWithHealthTracking<{
    fetched_at: Date;
    content_hash: string;
  }>(
    `SELECT fetched_at, content_hash FROM side_data_snapshots
      WHERE source = $1 ORDER BY created_at DESC LIMIT 1`,
    [source]
  );
  return res.rows[0] ?? null;
}

describe(
  "side-data persistence against a real Postgres (AAV-1339)",
  { skip: SKIP_REASON },
  () => {
    before(async () => {
      await queryWithHealthTracking(MIGRATION_SQL);
      // Self-heal a trigger left behind by an interrupted run, so the suite is
      // re-runnable instead of failing on the next INSERT.
      await dropBlockInsertTrigger();
      resetSideDataHashes();
      trackHash("categories", CATEGORIES_A);
      trackHash("categories", CATEGORIES_B);
      trackHash("forecast", FORECAST);
    });

    after(async () => {
      if (createdHashes.size > 0) {
        await queryWithHealthTracking(
          `DELETE FROM side_data_snapshots WHERE content_hash = ANY($1::text[])`,
          [[...createdHashes]]
        );
      }
      // Otherwise the pool's 30s idle timer keeps the process alive after the run.
      await closePool();
    });

    test("S1: INSERT lands a row and commits the hash", async () => {
      resetSideDataHashes();
      const fetchedAt = Date.now();
      await persistSideData("categories", CATEGORIES_A, fetchedAt);

      const row = await latestRow("categories");
      assert.ok(row, "a snapshot row must exist");
      assert.equal(
        row!.content_hash,
        buildSideDataPayload("categories", CATEGORIES_A, 0)!.contentHash,
        "the stored hash must be the hash of the stored form"
      );
      assert.equal(new Date(row!.fetched_at).getTime(), fetchedAt);
      assert.equal(getSideDataHashMapSize(), 1);
    });

    test("S2/S3: a real INSERT failure keeps the hash uncommitted and the retry lands it", async () => {
      resetSideDataHashes();
      await installBlockInsertTrigger();
      try {
        await persistSideData("categories", CATEGORIES_B, Date.now());
        assert.equal(
          getSideDataHashMapSize(),
          0,
          "a failed write must not commit the hash"
        );
      } finally {
        await dropBlockInsertTrigger();
      }

      // Backoff from the failure must not be mistaken for "already written".
      resetPoolHealth();
      const retryAt = Date.now();
      await persistSideData("categories", CATEGORIES_B, retryAt);

      assert.equal(getSideDataHashMapSize(), 1, "the retry commits the hash");
      const row = await latestRow("categories");
      assert.equal(new Date(row!.fetched_at).getTime(), retryAt);
    });

    test("S4: unchanged content advances fetched_at without adding a row", async () => {
      resetSideDataHashes();
      // Timestamps stay in the past so later tests keep the newest row.
      const first = Date.now() - 3_600_000;
      await persistSideData("forecast", FORECAST, first);
      const rowsAfterInsert = await rowCount("forecast");

      const later = first + 60_000;
      await persistSideData("forecast", FORECAST, later);

      assert.equal(
        await rowCount("forecast"),
        rowsAfterInsert,
        "identical content must not add a row"
      );
      const row = await latestRow("forecast");
      assert.equal(new Date(row!.fetched_at).getTime(), later);
    });

    test("S5/S9: after a restart-warm, the restored snapshot is inside the soft TTL and the next tick is a no-op", async () => {
      resetSideDataHashes();
      const refreshedAt = Date.now() - 60_000;
      await persistSideData("forecast", FORECAST, refreshedAt);

      // Simulates a process restart: hashes cleared, then warmed from the DB.
      resetSideDataHashes();
      const warmed = await warmSideDataFromDb();
      const restored = warmed.get("forecast");
      assert.ok(restored, "forecast snapshot must warm from the DB");
      assert.equal(restored!.fetchedAt, refreshedAt);
      assert.ok(
        Date.now() - restored!.fetchedAt <
          BACKEND_CACHE_TTL_MS.merklForecastResultDefault,
        "restored fetchedAt must be inside the soft TTL window"
      );

      // The warmed hash is the hash of the stored form, so the next identical
      // refresh must not write again (AAV-1339 defect C).
      const rowsBefore = await rowCount("forecast");
      await persistSideData("forecast", FORECAST, refreshedAt + 60_000);
      assert.equal(
        await rowCount("forecast"),
        rowsBefore,
        "warmed hash must suppress a duplicate row"
      );
      const row = await latestRow("forecast");
      assert.equal(new Date(row!.fetched_at).getTime(), refreshedAt + 60_000);
    });

    test("S5: a categories snapshot survives a restart inside its soft TTL (hasReusableCategoriesCache)", async () => {
      await clearTrackedRows("categories");
      resetSideDataHashes();
      const refreshedAt = Date.now() - 60_000;
      await persistSideData("categories", CATEGORIES_A, refreshedAt);

      // Simulates a process restart: hashes cleared, then warmed from the DB.
      resetSideDataHashes();
      const warmed = await warmSideDataFromDb();
      const restored = warmed.get("categories");
      assert.ok(restored, "categories snapshot must warm from the DB");
      assert.equal(restored!.fetchedAt, refreshedAt);
      // This is the predicate the ticket names: a restart must not re-hit
      // CoinGecko when the DB holds a refresh inside the soft TTL window.
      assert.ok(
        Date.now() - restored!.fetchedAt < COINGECKO_TTL.categoriesSoftTtlMs,
        "restored fetchedAt must satisfy hasReusableCategoriesCache()"
      );
    });

    test("the touched row is the one a restart reads (read/write ordering agree)", async () => {
      await clearTrackedRows("categories");
      resetSideDataHashes();
      // Two rows where creation order and fetched_at order disagree: A was
      // created last but holds the older snapshot. The touch must advance the
      // row `selectLatestSideData` would pick (B), not the newest-created one.
      const older = Date.now() - 7_200_000;
      const newer = Date.now() - 3_600_000;
      const liveHash = buildSideDataPayload(
        "categories",
        CATEGORIES_A,
        0
      )!.contentHash;
      await queryWithHealthTracking(
        `INSERT INTO side_data_snapshots (source, data, fetched_at, content_hash, created_at)
         VALUES ($1, $2::jsonb, $3, $4, NOW())`,
        [
          "categories",
          JSON.stringify({ __aav1339: "row-A" }),
          new Date(older).toISOString(),
          "hash-A",
        ]
      );
      await queryWithHealthTracking(
        `INSERT INTO side_data_snapshots (source, data, fetched_at, content_hash, created_at)
         VALUES ($1, $2::jsonb, $3, $4, NOW() - interval '1 hour')`,
        [
          "categories",
          JSON.stringify(CATEGORIES_A),
          new Date(newer).toISOString(),
          liveHash,
        ]
      );
      createdHashes.add("hash-A");

      // Warm so the in-memory hash matches what the DB holds (the normal state
      // after a restart) — otherwise this would take the INSERT path.
      await warmSideDataFromDb();

      const touchAt = Date.now();
      await persistSideData("categories", CATEGORIES_A, touchAt);

      const rows = await queryWithHealthTracking<{
        content_hash: string;
        fetched_at: Date;
      }>(
        `SELECT content_hash, fetched_at FROM side_data_snapshots
          WHERE source = $1`,
        ["categories"]
      );
      const byHash = new Map(
        rows.rows.map((r) => [r.content_hash, new Date(r.fetched_at).getTime()])
      );
      assert.equal(
        byHash.get("hash-A"),
        older,
        "the older snapshot must not be touched"
      );
      assert.equal(
        byHash.get(liveHash),
        touchAt,
        "the row a restart reads must carry the refreshed timestamp"
      );
    });

    test("retention: at most 3 rows survive per source", async () => {
      resetSideDataHashes();
      for (let i = 0; i < 4; i += 1) {
        const data = { __aav1339: `retention-${i}`, i };
        trackHash("categories", data);
        await persistSideData("categories", data, Date.now() + i);
      }
      assert.ok(
        (await rowCount("categories")) <= 3,
        "retention must trim to RETENTION_COUNT"
      );
    });
  }
);
