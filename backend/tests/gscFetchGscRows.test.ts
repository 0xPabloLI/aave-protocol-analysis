import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GscRow } from '../src/services/gscService.js';

const ROW_LIMIT = 25000;
const MAX_RETRIES = 3;

function makeRow(i: number): GscRow {
  return { keys: ['usa', `/p${i}`, `q${i}`], clicks: i, impressions: 10, ctr: 0.1, position: 5.0 };
}

function makeRows(count: number, offset = 0): GscRow[] {
  return Array.from({ length: count }, (_, i) => makeRow(offset + i));
}

function createMockWebmasters(responses: { rows?: GscRow[] }[], errors?: { attempt: number; code: number }[]) {
  const callLog: { startRow: number; rowLimit: number }[] = [];
  let responseIndex = 0;
  let attemptCounter = 0;
  const errorMap = new Map<number, number>();
  if (errors) {
    for (const e of errors) errorMap.set(e.attempt, e.code);
  }

  const query = async (params: { requestBody: { startRow: number; rowLimit: number } }) => {
    attemptCounter++;
    callLog.push({ startRow: params.requestBody.startRow, rowLimit: params.requestBody.rowLimit });

    const errCode = errorMap.get(attemptCounter);
    if (errCode) {
      const err = new Error(`HTTP ${errCode}`) as Error & { code: number };
      err.code = errCode;
      throw err;
    }

    const data = responses[responseIndex] ?? { rows: [] };
    responseIndex++;
    return { data };
  };

  return { searchanalytics: { query }, callLog };
}

async function setup(responses: { rows?: GscRow[] }[], errors?: { attempt: number; code: number }[]) {
  const mockWm = createMockWebmasters(responses, errors);
  const mod = await import('../src/services/gscService.js');
  mod.setGscClientForTest(mockWm as any);
  return { mockWm, fetchGscRows: mod.fetchGscRows };
}

test('fetchGscRows: single page when rows < ROW_LIMIT', async () => {
  const rows = makeRows(100);
  const { mockWm, fetchGscRows } = await setup([{ rows }]);

  const result = await fetchGscRows('2026-05-20', 'final', 'https://example.com');
  assert.equal(result.length, 100);
  assert.equal(mockWm.callLog.length, 1);
  assert.equal(mockWm.callLog[0].startRow, 0);
});

test('fetchGscRows: paginates when rows >= ROW_LIMIT', async () => {
  const page1 = makeRows(ROW_LIMIT, 0);
  const page2 = makeRows(500, ROW_LIMIT);
  const { mockWm, fetchGscRows } = await setup([{ rows: page1 }, { rows: page2 }]);

  const result = await fetchGscRows('2026-05-20', 'final', 'https://example.com');
  assert.equal(result.length, ROW_LIMIT + 500);
  assert.equal(mockWm.callLog.length, 2);
  assert.equal(mockWm.callLog[0].startRow, 0);
  assert.equal(mockWm.callLog[1].startRow, ROW_LIMIT);
});

test('fetchGscRows: three full pages then partial', async () => {
  const p1 = makeRows(ROW_LIMIT, 0);
  const p2 = makeRows(ROW_LIMIT, ROW_LIMIT);
  const p3 = makeRows(ROW_LIMIT, ROW_LIMIT * 2);
  const p4 = makeRows(100, ROW_LIMIT * 3);
  const { mockWm, fetchGscRows } = await setup([{ rows: p1 }, { rows: p2 }, { rows: p3 }, { rows: p4 }]);

  const result = await fetchGscRows('2026-05-20', 'final', 'https://example.com');
  assert.equal(result.length, ROW_LIMIT * 3 + 100);
  assert.equal(mockWm.callLog.length, 4);
  assert.equal(mockWm.callLog[3].startRow, ROW_LIMIT * 3);
});

test('fetchGscRows: empty result (no rows)', async () => {
  const { mockWm, fetchGscRows } = await setup([{ rows: undefined }]);

  const result = await fetchGscRows('2026-05-20', 'final', 'https://example.com');
  assert.equal(result.length, 0);
  assert.equal(mockWm.callLog.length, 1);
});

test('fetchGscRows: empty result (empty rows array)', async () => {
  const { mockWm, fetchGscRows } = await setup([{ rows: [] }]);

  const result = await fetchGscRows('2026-05-20', 'final', 'https://example.com');
  assert.equal(result.length, 0);
  assert.equal(mockWm.callLog.length, 1);
});

test('fetchGscRows: retries on 429 then succeeds', async () => {
  const rows = makeRows(50);
  const { mockWm, fetchGscRows } = await setup([{ rows }], [{ attempt: 1, code: 429 }]);

  const result = await fetchGscRows('2026-05-20', 'final', 'https://example.com');
  assert.equal(result.length, 50);
  assert.equal(mockWm.callLog.length, 2);
});

test('fetchGscRows: retries on 500 then succeeds', async () => {
  const rows = makeRows(30);
  const { mockWm, fetchGscRows } = await setup([{ rows }], [{ attempt: 1, code: 503 }]);

  const result = await fetchGscRows('2026-05-20', 'final', 'https://example.com');
  assert.equal(result.length, 30);
  assert.equal(mockWm.callLog.length, 2);
});

test('fetchGscRows: retries twice on consecutive 429 then succeeds', async () => {
  const rows = makeRows(10);
  const { mockWm, fetchGscRows } = await setup(
    [{ rows }],
    [{ attempt: 1, code: 429 }, { attempt: 2, code: 429 }],
  );

  const result = await fetchGscRows('2026-05-20', 'final', 'https://example.com');
  assert.equal(result.length, 10);
  assert.equal(mockWm.callLog.length, 3);
});

test('fetchGscRows: throws after MAX_RETRIES exhausted on 429', async () => {
  const { fetchGscRows } = await setup(
    [],
    [{ attempt: 1, code: 429 }, { attempt: 2, code: 429 }, { attempt: 3, code: 429 }],
  );

  await assert.rejects(
    () => fetchGscRows('2026-05-20', 'final', 'https://example.com'),
    (err: Error & { code?: number }) => err.code === 429,
  );
});

test('fetchGscRows: throws after MAX_RETRIES exhausted on 500', async () => {
  const { fetchGscRows } = await setup(
    [],
    [{ attempt: 1, code: 500 }, { attempt: 2, code: 500 }, { attempt: 3, code: 500 }],
  );

  await assert.rejects(
    () => fetchGscRows('2026-05-20', 'final', 'https://example.com'),
    (err: Error & { code?: number }) => err.code === 500,
  );
});

test('fetchGscRows: non-retryable error (403) throws immediately', async () => {
  const { mockWm, fetchGscRows } = await setup([], [{ attempt: 1, code: 403 }]);

  await assert.rejects(
    () => fetchGscRows('2026-05-20', 'final', 'https://example.com'),
    (err: Error & { code?: number }) => err.code === 403,
  );
  assert.equal(mockWm.callLog.length, 1);
});

test('fetchGscRows: non-retryable error (400) throws immediately', async () => {
  const { fetchGscRows } = await setup([], [{ attempt: 1, code: 400 }]);

  await assert.rejects(
    () => fetchGscRows('2026-05-20', 'final', 'https://example.com'),
    (err: Error & { code?: number }) => err.code === 400,
  );
});

test('fetchGscRows: pagination + retry interleaved', async () => {
  const page1 = makeRows(ROW_LIMIT, 0);
  const page2 = makeRows(100, ROW_LIMIT);
  const { mockWm, fetchGscRows } = await setup(
    [{ rows: page1 }, { rows: page2 }],
    [{ attempt: 2, code: 429 }],
  );

  const result = await fetchGscRows('2026-05-20', 'final', 'https://example.com');
  assert.equal(result.length, ROW_LIMIT + 100);
});

test('fetchGscRows: passes dataState parameter', async () => {
  const rows = makeRows(5);
  const { fetchGscRows } = await setup([{ rows }]);

  const result = await fetchGscRows('2026-05-20', 'all', 'https://example.com');
  assert.equal(result.length, 5);
});
