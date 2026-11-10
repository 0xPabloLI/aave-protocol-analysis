import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  SIDE_DATA_SOURCES,
  resetSideDataHashes,
  getSideDataHashMapSize,
  persistSideData,
  buildSideDataPayload,
  restoreSideDataFromPayload,
  selectLatestSideData,
} from "../src/services/sideDataPersistenceService.js";
import type { SideDataQuery } from "../src/services/sideDataPersistenceService.js";
import { computeHash } from "../src/services/persistenceService.js";
import { markPoolUnhealthy, resetPoolHealth } from "../src/services/dbPool.js";

// AAV-1339: the write path is exercised through its `query` seam, so the
// INSERT/UPDATE ordering is verifiable in CI without a live database. The real
// SQL runs against a real Postgres in sideDataPersistenceDb.test.ts.
// This URL is never dialed — only `isPersistenceEnabled()` reads it.
const TEST_DB_URL = "postgres://unused:unused@127.0.0.1:1/unused";
process.env.DATABASE_URL = TEST_DB_URL;

interface QueryCall {
  text: string;
  params?: unknown[];
}

const isInsert = (c: QueryCall) =>
  /INSERT INTO side_data_snapshots/i.test(c.text);
const isUpdate = (c: QueryCall) => /UPDATE side_data_snapshots/i.test(c.text);
const isDelete = (c: QueryCall) =>
  /DELETE FROM side_data_snapshots/i.test(c.text);

/** Records every query; `handler` may throw or return a custom rowCount. */
function recorder(handler?: (call: QueryCall) => { rowCount: number | null }): {
  calls: QueryCall[];
  query: SideDataQuery;
} {
  const calls: QueryCall[] = [];
  const query: SideDataQuery = async (text, params) => {
    const call: QueryCall = { text, params };
    calls.push(call);
    return handler ? handler(call) : { rowCount: 1 };
  };
  return { calls, query };
}

const CATEGORIES = {
  uniqueSymbolsStablecoins: ["USDC"],
  uniqueSymbolsEth: ["WETH"],
};
const FDV = { items: [{ id: "a", fdvUsd: 100 }] };

// Every case starts from a clean hash map (simulated process restart) and a
// healthy pool (clears the backoff a failed-write case deliberately sets).
beforeEach(() => {
  resetSideDataHashes();
  resetPoolHealth();
});

// ── Source constants ────────────────────────────────────────────────────────

test("SIDE_DATA_SOURCES: contains exactly 3 sources", () => {
  assert.strictEqual(SIDE_DATA_SOURCES.length, 3);
  assert.ok(SIDE_DATA_SOURCES.includes("categories"));
  assert.ok(SIDE_DATA_SOURCES.includes("fdv"));
  assert.ok(SIDE_DATA_SOURCES.includes("forecast"));
});

// ── Write path: change detection + hash-commit ordering (AAV-1339) ─────────
//
// Scenario numbers map to docs/plans/aav-1337-1344-codex-findings-cleanup-spec.md §3.

test("S1: INSERT succeeds → snapshot written, hash committed, retention cleanup runs", async () => {
  const rec = recorder();

  await persistSideData("categories", CATEGORIES, 1_700_000_000_000, rec.query);

  assert.equal(rec.calls.filter(isInsert).length, 1);
  assert.equal(rec.calls.filter(isDelete).length, 1);
  assert.equal(getSideDataHashMapSize(), 1);
});

test("S1b: INSERT carries the stored form of the data and its hash", async () => {
  const rec = recorder();
  const snapshot = {
    items: [{ campaignId: "c1" }],
    errors: [],
    staleTimeMs: 600_000,
  };

  await persistSideData("forecast", snapshot, 1_700_000_000_000, rec.query);

  const insert = rec.calls.find(isInsert);
  assert.ok(insert);
  const [source, dataJson, fetchedAtIso, contentHash] = insert!
    .params as string[];
  assert.equal(source, "forecast");
  assert.ok(
    !dataJson.includes("staleTimeMs"),
    "runtime-only fields are stripped"
  );
  assert.equal(fetchedAtIso, new Date(1_700_000_000_000).toISOString());
  assert.equal(
    contentHash,
    buildSideDataPayload("forecast", snapshot, 0)!.contentHash,
    "persisted hash must be the hash of the stored form"
  );
});

test("S2: INSERT fails → hash NOT committed, same content retries next time", async () => {
  const rec = recorder(() => {
    throw new Error("db down");
  });

  await persistSideData("categories", CATEGORIES, 1_000, rec.query);
  assert.equal(
    getSideDataHashMapSize(),
    0,
    "a failed write must not commit the hash"
  );

  resetPoolHealth(); // clear the backoff markPoolUnhealthy() just set
  await persistSideData("categories", CATEGORIES, 2_000, rec.query);
  assert.equal(
    rec.calls.filter(isInsert).length,
    2,
    "unchanged content must be retried while the DB holds no snapshot"
  );
  assert.equal(getSideDataHashMapSize(), 0);
});

test("S3: DB recovers → retry lands the snapshot and commits the hash", async () => {
  let attempt = 0;
  const rec = recorder(() => {
    attempt += 1;
    if (attempt === 1) throw new Error("db down");
    return { rowCount: 1 };
  });

  await persistSideData("fdv", FDV, 1_000, rec.query);
  resetPoolHealth();
  await persistSideData("fdv", FDV, 2_000, rec.query);

  assert.equal(rec.calls.filter(isInsert).length, 2);
  assert.equal(getSideDataHashMapSize(), 1);
});

test("S4: unchanged content → no INSERT, UPDATE advances fetched_at", async () => {
  const rec = recorder();
  const laterAt = 1_700_000_600_000;

  await persistSideData("categories", CATEGORIES, 1_700_000_000_000, rec.query);
  const before = rec.calls.length;
  await persistSideData("categories", CATEGORIES, laterAt, rec.query);
  const after = rec.calls.slice(before);

  assert.equal(
    after.filter(isInsert).length,
    0,
    "identical content must not add a row"
  );
  assert.equal(after.filter(isUpdate).length, 1);
  assert.ok(
    after[0].params!.includes(new Date(laterAt).toISOString()),
    "UPDATE must carry the new fetched_at"
  );
  assert.equal(getSideDataHashMapSize(), 1);
});

test("S7: UPDATE matches no row → falls back to INSERT (self-healing)", async () => {
  const rec = recorder((call) =>
    isUpdate(call) ? { rowCount: 0 } : { rowCount: 1 }
  );

  await persistSideData("categories", CATEGORIES, 1_000, rec.query);
  const before = rec.calls.length;
  await persistSideData("categories", CATEGORIES, 2_000, rec.query);
  const after = rec.calls.slice(before);

  assert.equal(after.filter(isUpdate).length, 1);
  assert.equal(
    after.filter(isInsert).length,
    1,
    "missing row must be re-created"
  );
});

test("S8: forecast staleTimeMs difference alone is not a content change", async () => {
  const rec = recorder();
  const base = { items: [{ campaignId: "c1" }], errors: [] };

  await persistSideData(
    "forecast",
    { ...base, staleTimeMs: 600_000 },
    1_000,
    rec.query
  );
  const before = rec.calls.length;
  await persistSideData(
    "forecast",
    { ...base, staleTimeMs: 123_456 },
    2_000,
    rec.query
  );
  const after = rec.calls.slice(before);

  assert.equal(after.filter(isInsert).length, 0);
  assert.equal(after.filter(isUpdate).length, 1);
});

test("S6: persistence disabled → zero queries, no throw, hash untouched", async () => {
  delete process.env.DATABASE_URL;
  const rec = recorder();

  try {
    await persistSideData("categories", CATEGORIES, 1_000, rec.query);

    assert.equal(rec.calls.length, 0);
    assert.equal(getSideDataHashMapSize(), 0);
  } finally {
    // Otherwise a failing assertion leaves persistence disabled for the rest
    // of the file (the suites below share one process).
    process.env.DATABASE_URL = TEST_DB_URL;
  }
});

test("S6b: pool in backoff → zero queries", async () => {
  markPoolUnhealthy();
  const rec = recorder();

  await persistSideData("categories", CATEGORIES, 1_000, rec.query);

  assert.equal(rec.calls.length, 0);
});

test("null / undefined data → zero queries", async () => {
  const rec = recorder();

  await persistSideData("categories", null, 1_000, rec.query);
  await persistSideData("fdv", undefined, 1_000, rec.query);
  await persistSideData("forecast", null, 1_000, rec.query);

  assert.equal(rec.calls.length, 0);
  assert.equal(getSideDataHashMapSize(), 0);
});

// ── Hash map management (AAV-1338: bounded at one entry per source) ─────────

test("getSideDataHashMapSize: 0 after reset", () => {
  resetSideDataHashes();
  assert.strictEqual(getSideDataHashMapSize(), 0);
});

test("getSideDataHashMapSize: increments as sources are persisted", async () => {
  const rec = recorder();

  await persistSideData("categories", CATEGORIES, 1_000, rec.query);
  await persistSideData("fdv", FDV, 2_000, rec.query);
  assert.strictEqual(getSideDataHashMapSize(), 2);
  await persistSideData("forecast", { items: [] }, 3_000, rec.query);
  assert.strictEqual(getSideDataHashMapSize(), 3);
});

test("getSideDataHashMapSize: does not exceed 3 (one per source)", async () => {
  const rec = recorder();

  await persistSideData("categories", { a: 1 }, 1_000, rec.query);
  await persistSideData("categories", { a: 2 }, 2_000, rec.query);
  await persistSideData("categories", { a: 3 }, 3_000, rec.query);
  assert.strictEqual(getSideDataHashMapSize(), 1);
});

// ── buildSideDataPayload / restoreSideDataFromPayload round-trip ───────────

test("buildSideDataPayload: categories — produces { data, fetchedAt, contentHash }", () => {
  const cachedData = {
    uniqueSymbolsStablecoins: ["USDC", "DAI"],
    uniqueSymbolsEth: ["WETH"],
  };
  const fetchedAt = Date.now();
  const payload = buildSideDataPayload("categories", cachedData, fetchedAt);
  assert.ok(payload !== null);
  assert.deepStrictEqual(payload!.data, cachedData);
  assert.strictEqual(payload!.fetchedAt, fetchedAt);
  assert.ok(typeof payload!.contentHash === "string");
  assert.ok(payload!.contentHash.length > 0);
});

test("buildSideDataPayload: fdv — preserves items array with fetchedAt ISO string", () => {
  const cachedData = {
    items: [{ id: "a", fdvUsd: 100 }],
    fetchedAt: "2026-01-01T00:00:00.000Z",
  };
  const fetchedAt = 1700000000000;
  const payload = buildSideDataPayload("fdv", cachedData, fetchedAt);
  assert.ok(payload !== null);
  assert.deepStrictEqual(payload!.data, cachedData);
  assert.strictEqual(payload!.fetchedAt, fetchedAt);
});

test("buildSideDataPayload: forecast — stores only items+errors, not staleTimeMs", () => {
  const snapshot = {
    items: [{ campaignId: "c1", distributedSoFar: 100, endTimestamp: 999 }],
    errors: [],
    staleTimeMs: 600000,
  };
  const fetchedAt = Date.now();
  const payload = buildSideDataPayload("forecast", snapshot, fetchedAt);
  assert.ok(payload !== null);
  const payloadData = payload!.data as Record<string, unknown>;
  // data should NOT include staleTimeMs
  assert.ok(!("staleTimeMs" in payloadData));
  assert.deepStrictEqual(payloadData.items, snapshot.items);
  assert.deepStrictEqual(payloadData.errors, snapshot.errors);
});

test("buildSideDataPayload: null data → returns null", () => {
  assert.strictEqual(
    buildSideDataPayload("categories", null, Date.now()),
    null
  );
  assert.strictEqual(buildSideDataPayload("fdv", null, Date.now()), null);
  assert.strictEqual(buildSideDataPayload("forecast", null, Date.now()), null);
});

// ── restoreSideDataFromPayload ──────────────────────────────────────────────

test("restoreSideDataFromPayload: categories — restores { data, fetchedAt }", () => {
  const data = {
    uniqueSymbolsStablecoins: ["USDC"],
    uniqueSymbolsEth: ["WETH"],
  };
  const fetchedAt = 1700000000000;
  const restored = restoreSideDataFromPayload("categories", {
    data,
    fetchedAt,
    contentHash: "abc",
  });
  assert.ok(restored !== null);
  assert.deepStrictEqual(restored!.data, data);
  assert.strictEqual(restored!.fetchedAt, fetchedAt);
});

test("restoreSideDataFromPayload: fdv — restores { data, fetchedAt }", () => {
  const data = {
    items: [{ id: "a", fdvUsd: 100 }],
    fetchedAt: "2026-01-01T00:00:00.000Z",
  };
  const fetchedAt = 1700000000000;
  const restored = restoreSideDataFromPayload("fdv", {
    data,
    fetchedAt,
    contentHash: "abc",
  });
  assert.ok(restored !== null);
  assert.deepStrictEqual(restored!.data, data);
  assert.strictEqual(restored!.fetchedAt, fetchedAt);
});

test("restoreSideDataFromPayload: forecast — restores snapshot with staleTimeMs", () => {
  const data = { items: [{ campaignId: "c1" }], errors: [] };
  const fetchedAt = 1700000000000;
  const restored = restoreSideDataFromPayload("forecast", {
    data,
    fetchedAt,
    contentHash: "abc",
  });
  assert.ok(restored !== null);
  const restoredData = restored!.data as {
    items: unknown[];
    errors: unknown[];
    staleTimeMs: number;
  };
  assert.deepStrictEqual(restoredData.items, data.items);
  assert.deepStrictEqual(restoredData.errors, data.errors);
  // staleTimeMs should be restored (from constant, not from DB)
  assert.ok("staleTimeMs" in restoredData);
  assert.strictEqual(restored!.fetchedAt, fetchedAt);
});

test("restoreSideDataFromPayload: null payload → returns null", () => {
  assert.strictEqual(restoreSideDataFromPayload("categories", null), null);
  assert.strictEqual(restoreSideDataFromPayload("fdv", null), null);
  assert.strictEqual(restoreSideDataFromPayload("forecast", null), null);
});

test("restoreSideDataFromPayload: missing items in forecast data → returns null", () => {
  const badPayload = {
    data: { errors: [] },
    fetchedAt: 1700000000000,
    contentHash: "abc",
  };
  const restored = restoreSideDataFromPayload("forecast", badPayload);
  assert.strictEqual(restored, null);
});

// ── selectLatestSideData ────────────────────────────────────────────────────

test("selectLatestSideData: returns null for empty array", () => {
  assert.strictEqual(selectLatestSideData([]), null);
});

test("selectLatestSideData: returns the row with the latest fetched_at", () => {
  const rows = [
    {
      source: "categories",
      data: { old: true },
      fetched_at: "2026-01-01T00:00:00Z",
      content_hash: "a",
      created_at: "2026-01-01T00:00:00Z",
    },
    {
      source: "categories",
      data: { new: true },
      fetched_at: "2026-01-02T00:00:00Z",
      content_hash: "b",
      created_at: "2026-01-02T00:00:00Z",
    },
    {
      source: "categories",
      data: { mid: true },
      fetched_at: "2026-01-01T12:00:00Z",
      content_hash: "c",
      created_at: "2026-01-01T12:00:00Z",
    },
  ];
  const latest = selectLatestSideData(rows);
  assert.ok(latest !== null);
  assert.deepStrictEqual(latest!.data, { new: true });
});

test("selectLatestSideData: handles single row", () => {
  const rows = [
    {
      source: "fdv",
      data: { items: [] },
      fetched_at: "2026-01-01T00:00:00Z",
      content_hash: "x",
      created_at: "2026-01-01T00:00:00Z",
    },
  ];
  const latest = selectLatestSideData(rows);
  assert.ok(latest !== null);
  assert.deepStrictEqual(latest!.data, { items: [] });
});

// ── Cross-step contract: hash consistency ──────────────────────────────────

test("contentHash from buildSideDataPayload matches computeHash of data", () => {
  const data = {
    uniqueSymbolsStablecoins: ["USDC"],
    uniqueSymbolsEth: ["WETH"],
  };
  const payload = buildSideDataPayload("categories", data, Date.now());
  assert.ok(payload !== null);
  const expectedHash = computeHash([data]);
  assert.strictEqual(payload!.contentHash, expectedHash);
});
