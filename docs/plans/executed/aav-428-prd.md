# AAV-428 PRD: V3/V4 Concurrent Fetch — Package Boundary Refactor + Promise.allSettled

## Problem Statement

V3 和 V4 的数据获取当前是串行的：先 `fetchRawMarketData()` 完成 V3 全链获取，再在 `buildMarketsBaseDataset()` 内部 `await fetchV4ReservesData()` 获取 V4。总耗时 = V3 + V4（可达 40s），挤占外层 60s 硬超时预算，留给 RPC fallback / 增量逻辑的余量不足。同时 `buildMarketsBaseDataset` 混合了异步 fetch 和同步 merge，违反单一职责，难以独立测试 merge 逻辑。

## Solution

将 V3/V4 fetch 提取到 `fetchMarketsData` 层并发执行（`Promise.allSettled`），`buildMarketsBaseDataset` 退化为纯同步函数。per-side 成败通过 `_metadata.fetchResult` 结构化信封传递给 backend，fatal/stale 决策权归 backend（AAV-566）。

## User Stories

1. As a backend operator, I want V3 and V4 data fetched concurrently, so that total fetch time is bounded by max(V3, V4) instead of V3+V4
2. As a backend operator, I want each side to have independent 35s timeout, so that one slow side cannot starve the other
3. As a backend operator, I want per-side success/failure reported in metadata, so that backend can make per-side stale merge decisions (AAV-566)
4. As a developer, I want `buildMarketsBaseDataset` to be a pure sync function, so that merge logic is independently testable without mocking async fetches
5. As a developer, I want V3/V4 error handling to be symmetric, so that the concurrency model is conceptually simple and predictable
6. As a developer, I want `fetchV4ReservesWithTimeout` DI-mockable, so that I can test timeout and failure paths without real SDK calls
7. As a developer, I want `fetchV3MarketsWithTimeout` DI-mockable, so that I can test V3 timeout and failure paths without real SDK calls
8. As a CLI user, I want `runMarketsFetcher` to also use concurrent fetch, so that CLI behavior matches backend behavior
9. As a backend operator, I want both-side total failure to throw, so that the caller knows the entire refresh failed
10. As a backend operator, I want single-side failure to NOT throw, so that partial data is still available for the successful side
11. As a developer, I want `fetchResult` envelope in `_metadata` to use ADR-0022 format, so that AAV-566 can consume it without migration
12. As a developer, I want `v4Fatal` removed from `fetchMarketsData` options, so that fatal/stale decisions are centralized in backend

## Implementation Decisions

### Module 1: `fetchV3MarketsWithTimeout` (new export)

- Wraps `fetchRawMarketData()` with `withTimeout(promise, 35_000, 'V3 fetch timeout')`
- Returns `{ markets: MarketData['markets'] }` on success
- Throws on timeout or fetch failure
- Supports DI via `_fetchV3Fn` option for testing (same pattern as existing `fetchV4ReservesWithTimeout`)

### Module 2: `fetchV4ReservesWithTimeout` (existing, modify)

- Change timeout from 25s to 35s
- Remove `v4Fatal` parameter — always call `fetchV4ReservesData({ throwOnFinalFailure: false })`
- Timeout/retry failure → throw (caught by `Promise.allSettled` in caller)
- Keep existing DI (`_fetchV4Fn`, `_fetchV4RpcFn`) for testability
- Keep `source` field in return value (`'sdk' | 'rpc' | 'none'`)

### Module 3: `buildMarketsBaseDataset` (existing, refactor to pure sync)

- Remove `async` keyword, return plain object (not Promise)
- Remove `options.v4Fatal` parameter
- Remove V4 fetch logic (no more `Promise.race`, no more `fetchV4ReservesData` call)
- New signature: `buildMarketsBaseDataset(v3Markets: any[], v4Result: V4FetchResult) → { baseDataset, v3Count, v4Count, v4Dataset, v4Raw, spokeHubTopology }`
- Pure merge: `buildV3BaseDataset(v3Markets)` + v4Result.mapped → concatenated baseDataset

### Module 4: `fetchMarketsData` (existing, modify)

- Remove `v4Fatal` from options
- Concurrent fetch with `Promise.allSettled`
- Per-side result extraction: check `status` of each settled result
- Call `buildMarketsBaseDataset(v3Markets, v4Result)` (sync)
- Write `_metadata.fetchResult` envelope per ADR-0022
- Both sides failed → throw Error('Both V3 and V4 fetch failed')

### Module 5: `runMarketsFetcher` (existing, modify)

- Same concurrent pattern as `fetchMarketsData`
- V3/V4 并发 → `buildMarketsBaseDataset` (sync) → incentive fetches → enrich

### Module 6: `_metadata.fetchResult` envelope

```typescript
fetchResult: {
  v3: { success: boolean; source: 'sdk' | 'timeout' | 'error' };
  v4: { success: boolean; source: 'sdk' | 'rpc' | 'none' | 'timeout' | 'error' };
}
```

### Module 7: Cleanup

- Remove `v4Fatal` from `buildMarketsBaseDataset` catch block and throw logic
- Remove V4_FETCH_TIMEOUT_MS constant (replaced by shared FETCH_TIMEOUT_MS = 35_000)
- `fetchV4ReservesData.throwOnFinalFailure` retained (independent function option), but `fetchMarketsData` always passes `false`

## Testing Decisions

- **Good test**: test external behavior (output shape, per-side success/failure, timeout handling) via DI mocks, not implementation details
- **Modules to test**:
  1. `buildMarketsBaseDataset` — pure sync merge (existing tests verify)
  2. `fetchV3MarketsWithTimeout` — DI mock: success, timeout throw, fetch error throw
  3. `fetchV4ReservesWithTimeout` — existing DI tests; update for 35s timeout + no v4Fatal
  4. `fetchMarketsData` — integration-level: all 4 Promise.allSettled scenarios + `_metadata.fetchResult` shape
- **Prior art**: `fetchMarketsData-concurrency.test.ts` uses DI pattern with `node:test` + `node:assert/strict`

## Out of Scope

- Backend per-side stale merge (`mergeWithPartialStale`) — AAV-566
- `_metadata.fetchResult` consumer logic in backend — AAV-566
- RPC fallback implementation — ADR-0021, future work
- V3 internal per-chain concurrency (V3 still serial per-chain, only V3 vs V4 is concurrent)

## Further Notes

- ADR-0020 already accepted the concurrent + per-side stale merge decision. This PRD implements the fetcher-internal half.
- ADR-0022 defines the `fetchResult` envelope format — we implement it now to avoid a rename migration in AAV-566.
- `fetchV4ReservesData.throwOnFinalFailure` is retained as an independent function option (not removed), but `fetchMarketsData` always passes `false`. The fatal/stale decision is backend's responsibility.
- AAV-566 is blocked by this issue.
