# ADR-0022: Structured `fetchResult` Envelope (Replacing Flat `_v3Succeeded`/`_v4Succeeded`)

Date: 2026-05-26
References: AAV-388, ADR-0020

## Status

Implemented

## Context

ADR-0020 引入 V3/V4 并发 fetch + per-side stale merge 时，fetcher 需要把 "V3/V4 各自是否成功" 的信号传给 backend。第一版用了扁平的下划线前缀字段：

```typescript
// packages/aave-shared-contracts/src/index.ts (current)
export interface MarketsPayload {
  _metadata: {
    timestamp: string;
    version: string;
    dataCount: number;
    profile: string;
    _v3Succeeded?: boolean;
    _v4Succeeded?: boolean;
  };
  data: RuntimeReserveData[];
  // ...
}
```

backend 直接读：

```typescript
const v3Succeeded = payload._metadata._v3Succeeded ?? true;
const v4Succeeded = payload._metadata._v4Succeeded ?? true;
```

问题：

1. **下划线前缀传达"内部字段"语义，但实际是跨包契约**（fetcher → backend）。下划线只能让前端忽略，不能阻止 backend 依赖；命名误导。
2. **无法扩展到 source 信息**：ADR-0021 需要表达 `source ∈ {'sdk', 'rpc', 'stale'}` 来标识数据来自哪一层。继续加 `_v4Source` 会导致扁平字段爆炸（每加一个维度多一个字段）。
3. **`?? true` 默认值丢失语义**：absent 表示"旧版 fetcher 不写此字段"还是"成功"？现在两者重合，但若未来字段含义变化，向后兼容会出问题。
4. **类型层无法表达 "v3.success=false 时 v3.source 不可能是 'sdk'"** 这类约束，扁平 boolean + 独立 source 字段会出现自相矛盾的组合。

## Decision

把扁平字段重构为结构化 `fetchResult` envelope：

```typescript
// packages/aave-shared-contracts/src/index.ts (new)
export type FetchSource = 'sdk' | 'rpc' | 'stale' | 'none';

export interface SideFetchResult {
  /** Whether this side has any data in the final dataset (regardless of source). */
  success: boolean;
  /** Where the data came from. 'none' iff success=false. */
  source: FetchSource;
}

export interface MarketsPayload {
  _metadata: {
    timestamp: string;
    version: string;
    dataCount: number;
    profile: string;
    fetchResult: {
      v3: SideFetchResult;
      v4: SideFetchResult;
    };
  };
  data: RuntimeReserveData[];
  // ...
}
```

### 字段语义约束

| `success` | `source` | 含义 |
|---|---|---|
| `true` | `'sdk'` | SDK 主路径成功 |
| `true` | `'rpc'` | SDK 失败，RPC inline fallback 成功（V4 only，参见 ADR-0021） |
| `true` | `'stale'` | SDK + RPC 均失败，backend per-side stale 兜底成功 |
| `false` | `'none'` | 该 side 所有兜底层均失败，data 中无该 side reserve |

**注**：Fetcher 只产出 `source ∈ {'sdk', 'rpc', 'none'}`。`source === 'stale'` 由 backend 层 `correctFetchResult()` 在 stale merge 后覆写。stale 层的可见性也通过 `v4FallbackReserveIds` 表达。

### Backend Layer fetchResult Correction

After `mergeWithPartialStale()` runs, backend corrects `fetchResult` to reflect post-merge reality. The correction formula:

```
success = v3Present / v4Present
source  = v3Fresh ? fetchResult.v3.source : (v3Present ? 'stale' : 'none')
```

Where:
- `v3Fresh` / `v4Fresh` — from `mergeWithPartialStale` output (side data came from fresh fetch)
- `v3Present` / `v4Present` — from `mergeWithPartialStale` output (side has data in merged dataset, regardless of source)

This ensures:
- Fresh path preserves the original source (e.g., `'sdk'` or future `'rpc'`)
- Stale fallback path writes `{ success: true, source: 'stale' }`
- Total failure writes `{ success: false, source: 'none' }`

The outer catch path (entire `fetchMarketsData()` throws) delegates stale selection to `mergeWithPartialStale` instead of manually constructing fallback data, ensuring consistent stale TTL enforcement across all code paths.

### 向后兼容策略

- 旧版 fetcher 仍可能产出无 `fetchResult` 的 payload（如启动期、回滚场景）。backend 读时：
  ```typescript
  const v3 = payload._metadata.fetchResult?.v3 ?? { success: true, source: 'sdk' };
  const v4 = payload._metadata.fetchResult?.v4 ?? { success: true, source: 'sdk' };
  ```
- 一次性弃用 `_v3Succeeded` / `_v4Succeeded`：删除字段定义和所有 reader。grep 跨仓确认零引用。

### 范围

- ✏️ `packages/aave-shared-contracts/src/index.ts`：删除 `_v3Succeeded`/`_v4Succeeded`，添加 `FetchSource`/`SideFetchResult`/`fetchResult`。
- ✏️ `packages/aave-fetcher/src/index.ts`：写入 `fetchResult` 而非两个 boolean。
- ✏️ `backend/src/services/marketsService.ts`：读 `fetchResult`，传给 `mergeWithPartialStale()`。`mergeWithPartialStale` 内部签名保留 boolean（pure function 不需关心 source 来源）。
- ✏️ `backend/src/services/marketsService.ts`：新增 `correctFetchResult()` 纯函数，merge 后覆写 `payload._metadata.fetchResult` 反映 post-merge 实际数据来源。
- ✏️ `backend/src/services/marketsService.ts`：`PartialStaleMergeResult` 新增 `v3Present`/`v4Present` 字段，供 `correctFetchResult` 使用。
- ✏️ `backend/src/services/marketsService.ts`：outer catch 简化，删除手动 stale 合并，统一交给 `mergeWithPartialStale`。
- ✏️ `backend/tests/partialStaleMerge.test.ts`：fixture 适配新签名 + `v3Present`/`v4Present` + `correctFetchResult` 测试。
- ✏️ `packages/aave-fetcher/tests/fetchMarketsData-concurrency.test.ts`：assert `fetchResult` 结构。

## Alternatives Considered

### A. 保留 `_v3Succeeded`/`_v4Succeeded`，再加 `_v3Source`/`_v4Source`

- Pro：渐进改动小
- Con：4 个相关字段彼此约束，类型层无法表达；命名前缀仍误导
- Rejected

### B. 把 V3/V4 数据分两个顶层字段（`payload.v3`, `payload.v4`）

- Pro：结构最清晰
- Con：破坏现有 `data: RuntimeReserveData[]` 扁平契约，下游消费者全部要改
- Rejected

### C. `fetchResult` envelope（本 ADR）

- Accepted

## Consequences

- **Positive**：跨包契约明确，没有下划线"内部"的伪装；source 字段为 ADR-0021 RPC 层留好扩展位
- **Positive**：类型层 `SideFetchResult` 把 `success + source` 绑定，未来添加新 source（如 `'cache'`、`'partial-rpc'`) 只需扩展枚举
- **Positive**：default 行为（absent ⇒ `{success: true, source: 'sdk'}`）显式声明，无歧义
- **Negative**：一次性破坏性 rename，需要同步改 fetcher / backend / tests / 已 build 的 dist；要在同一 commit 内完成
- **Negative**：相关 issue 应作为单独 vertical slice 拆分（拆解到 to-issues 时单独建一条），不与 RPC fallback 实现混在一起

## References

- ADR-0020: V3/V4 Concurrent Fetch + Per-Side Stale Merge（引入扁平字段的来源）
- ADR-0021: Three-Layer V4 Fallback（消费 `source` 字段表达层降级）
- Current code: `packages/aave-shared-contracts/src/index.ts`, `backend/src/services/marketsService.ts` (`correctFetchResult`, `mergeWithPartialStale`)
