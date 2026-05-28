# ADR-0020: V3/V4 Concurrent Fetch + Per-Side Partial Stale Merge

Date: 2026-05-26
References: AAV-388, PRD c6ab55629364

## Status

Accepted

## Context

历史实现是顺序刷新：

```
fetchMarketsData():
  V3 SDK fetch (10-15s)
  → V4 SDK fetch (with isolation timeout, 25s)
  → buildMarketsBaseDataset()
```

存在两个问题：

1. **预算浪费**：V3 + V4 串行，总耗时 = V3 + V4，挤占外层 60s `MARKETS_FETCH_TIMEOUT_MS`。V4 SDK 偶发慢响应（25s 隔离）+ V3 正常耗时（15s）= 40s 已被吃掉，留给后续 fallback/RPC 兜底的预算极少。
2. **整体 fallback 粒度过粗**：旧逻辑只有 "整批 markets 为空 → 保留上一次 snapshot"。若 V4 SDK 单边失败（返回空集）而 V3 正常，旧逻辑把整个新 payload 当 fresh 写入 snapshot，V4 数据直接消失——前端看到 V4 markets 空白。

PRD（AAV-388）原方案是 "SDK 失败时触发 RPC 直读"，但 RPC 兜底实现复杂（需新建 `aave-rpc-infra` 包、复刻 Hub+Spoke ABI 解析逻辑），上线周期较长。需要一个**正交的安全网**：即使 RPC 兜底也未上线/失败，单 side 的偶发失败也不应抹掉 fresh 数据。

## Decision

采取两项联动改造：

### 1. V3/V4 并发 fetch + per-side 独立 timeout

`fetchMarketsData()` 与 `runMarketsFetcher()` 都改为：

```typescript
const [v3Settled, v4Settled] = await Promise.allSettled([
  fetchV3MarketsWithTimeout(),          // 35s 独立 timeout
  fetchV4ReservesWithTimeout({ v4Fatal }), // 35s 独立 timeout
]);
```

总耗时 = `max(V3, V4)`，最差 35s。`buildMarketsBaseDataset` 退化为纯 sync 函数，只做 V3+V4 数据合并。

### 2. backend 层 per-side staleData

`backend/src/services/marketsService.ts` 维护两套缓存：

```typescript
let staleV3Data: RuntimeReserveData[] = [];
let staleV4Data: RuntimeReserveData[] = [];
let v3FetchedAt: number | null = null;
let v4FetchedAt: number | null = null;
```

刷新流程（纯函数 `mergeWithPartialStale()`，见单测 `partialStaleMerge.test.ts`）：

| 场景 | merged 结果 | stale 状态 |
|---|---|---|
| V3 ✓ V4 ✓ | freshV3 + freshV4 | 两个 stale 更新为新数据 |
| V3 ✗ V4 ✓ + V3 stale 在 TTL 内 | staleV3 + freshV4 | V3 stale 保留，V4 stale 更新 |
| V3 ✓ V4 ✗ + V4 stale 在 TTL 内 | freshV3 + staleV4 | V3 stale 更新，V4 stale 保留 |
| V3 ✗ V4 ✗ + 两个 stale 在 TTL 内 | staleV3 + staleV4 | 两个 stale 保留 |
| 单 side 失败 + 该 side stale 超 TTL | 该 side = []，对侧正常合并 | 不更新 |
| 两 side 都失败 + 两个 stale 都超 TTL | merged = [] → 抛 Error | 不更新 |

side 区分：当前用 `(reserve as any).hubId` 启发式（V4 有 hubId，V3 没有）。

side-channel：fetcher 在 `MarketsPayload._metadata` 写入 `_v3Succeeded` / `_v4Succeeded`（参见 ADR-0022 将其重命名为结构化的 `fetchResult` envelope）。

## Alternatives Considered

### A. 保持顺序 fetch，仅做整体 fallback

- Pro：实现最简单
- Con：单 side 失败导致整批 fresh 被抹；预算紧张
- Rejected

### B. 并发 fetch + 整体 fallback（不做 per-side stale）

- Pro：解决预算问题
- Con：V4 偶发空集仍会导致 V4 数据丢失（fresh V4 = []）
- Rejected

### C. RPC fallback 取代 stale fallback（PRD 原方案）

- Pro：兜底来源是当前链上数据，新鲜度高
- Con：实现复杂、上线周期长；且不解决 V3 单边失败问题（V3 没有 RPC fallback 计划）
- 不作互斥替代：v0.1 stale + 后续 RPC 共存，三层兜底见 ADR-0021

### D. 当前决策（并发 + per-side stale）

- Pro：覆盖 V3/V4 双向单边失败；零额外 RPC/外部依赖；纯函数化便于单测；正交于 RPC fallback
- Pro：总耗时压缩 ≥ 30%（顺序 ~45s → 并发 ~35s 上限）
- Con：backend 维护 stale 缓存增加状态管理面（refresh 之间共享 module-level 变量）；用 `hubId` 启发式区分 V3/V4 不是类型严格区分
- Accepted

## Consequences

- **Positive**：单 side 失败不再丢数据，前端 V3/V4 markets 都能维持显示
- **Positive**：fetcher 总耗时上限收紧到 ~35s（外层 60s 仍是硬 kill，留出充足 buffer 给 RPC fallback / 增量逻辑）
- **Positive**：`mergeWithPartialStale()` 是纯函数，10+ 个单测覆盖（`backend/tests/partialStaleMerge.test.ts`）
- **Negative**：backend `marketsService.ts` 引入 module-level 可变状态（`staleV3Data`, `staleV4Data`, `v3FetchedAt`, `v4FetchedAt`），测试需注意状态泄漏
- **Negative**：V3/V4 区分依赖 `hubId` 启发式，类型层 `RuntimeReserveData` 未做严格 discriminated union（与 ADR-0019 决定不暴露 `protocolVersion` 一致）
- **Neutral**：stale 数据 TTL 当前复用 `marketsHardTtlMs`；待 RPC fallback 上线后是否调短另行评估（见 ADR-0021）

## References

- ADR-0019: protocolVersion Not Exposed in API Response（决定不在 reserve 层暴露 v3/v4 标记 → 本 ADR 用 `hubId` 启发式区分）
- ADR-0021: Three-Layer V4 Fallback（本 ADR 是其 stale 兜底层）
- ADR-0022: Structured fetchResult Envelope（重命名 `_v3Succeeded`/`_v4Succeeded`）
- Tests: `backend/tests/partialStaleMerge.test.ts`, `packages/aave-fetcher/tests/fetchMarketsData-concurrency.test.ts`
- Code: `backend/src/services/marketsService.ts:62-152` (`mergeWithPartialStale`), `packages/aave-fetcher/src/index.ts` (`fetchV3MarketsWithTimeout`, `fetchV4ReservesWithTimeout`)
- Linear PRD: https://linear.app/aaveapy/document/prd-v4-sdk-fallback-direct-chain-read-when-sdk-returns-empty-c6ab55629364
