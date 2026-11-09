import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SIDE_DATA_SOURCES,
  resetSideDataHashes,
  getSideDataHashMapSize,
  shouldPersistSideData,
  buildSideDataPayload,
  restoreSideDataFromPayload,
  selectLatestSideData,
} from "../src/services/sideDataPersistenceService.js";
import { computeHash } from "../src/services/persistenceService.js";

// ── Source constants ────────────────────────────────────────────────────────

test("SIDE_DATA_SOURCES: contains exactly 3 sources", () => {
  assert.strictEqual(SIDE_DATA_SOURCES.length, 3);
  assert.ok(SIDE_DATA_SOURCES.includes("categories"));
  assert.ok(SIDE_DATA_SOURCES.includes("fdv"));
  assert.ok(SIDE_DATA_SOURCES.includes("forecast"));
});

// ── Content-hash change detection ───────────────────────────────────────────

test("shouldPersistSideData: returns true when no previous hash exists", () => {
  resetSideDataHashes();
  assert.ok(shouldPersistSideData("categories", { a: 1 }));
});

test("shouldPersistSideData: returns false when hash unchanged", () => {
  resetSideDataHashes();
  const data = {
    uniqueSymbolsStablecoins: ["USDC"],
    uniqueSymbolsEth: ["WETH"],
  };
  // First call stores the hash
  assert.ok(shouldPersistSideData("categories", data));
  // Second call with same data → false
  assert.ok(!shouldPersistSideData("categories", data));
});

test("shouldPersistSideData: returns true when data changed", () => {
  resetSideDataHashes();
  const data1 = { items: [{ id: "a", fdvUsd: 100 }] };
  const data2 = { items: [{ id: "a", fdvUsd: 200 }] };
  assert.ok(shouldPersistSideData("fdv", data1));
  assert.ok(shouldPersistSideData("fdv", data2));
});

test("shouldPersistSideData: independent per source", () => {
  resetSideDataHashes();
  const cats = { uniqueSymbolsStablecoins: [] };
  const fdv = { items: [] };
  assert.ok(shouldPersistSideData("categories", cats));
  assert.ok(shouldPersistSideData("fdv", fdv));
  // categories unchanged → false, fdv unchanged → false
  assert.ok(!shouldPersistSideData("categories", cats));
  assert.ok(!shouldPersistSideData("fdv", fdv));
});

test("shouldPersistSideData: null data → false", () => {
  resetSideDataHashes();
  assert.ok(!shouldPersistSideData("categories", null));
  assert.ok(!shouldPersistSideData("fdv", null));
  assert.ok(!shouldPersistSideData("forecast", null));
});

test("shouldPersistSideData: undefined data → false", () => {
  resetSideDataHashes();
  assert.ok(!shouldPersistSideData("categories", undefined));
});

// ── Hash map management ─────────────────────────────────────────────────────

test("getSideDataHashMapSize: 0 after reset", () => {
  resetSideDataHashes();
  assert.strictEqual(getSideDataHashMapSize(), 0);
});

test("getSideDataHashMapSize: increments as sources are hashed", () => {
  resetSideDataHashes();
  shouldPersistSideData("categories", { a: 1 });
  shouldPersistSideData("fdv", { b: 2 });
  assert.strictEqual(getSideDataHashMapSize(), 2);
  shouldPersistSideData("forecast", { c: 3 });
  assert.strictEqual(getSideDataHashMapSize(), 3);
});

test("getSideDataHashMapSize: does not exceed 3 (one per source)", () => {
  resetSideDataHashes();
  shouldPersistSideData("categories", { a: 1 });
  shouldPersistSideData("categories", { a: 2 });
  shouldPersistSideData("categories", { a: 3 });
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
