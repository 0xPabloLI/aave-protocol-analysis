# ADR-0021: Three-Layer V4 Fallback — SDK → RPC → Stale

Date: 2026-05-26
References: AAV-388, PRD c6ab55629364

## Status

Implemented

> **2026-06-06 (AAV-582 + AAV-583)**: Layer 2 fully wired.
> - Fixed `buildReserveData` `reserveId` to use `hubAddress` (not `hubName`) so stale merge keys are consistent across all layers.
> - Wired `fetchV4ReservesViaRpc` into `fetchV4ReservesWithTimeout` as Layer 2: SDK empty/timeout → RPC 15s → `source: 'rpc'`.
> - `fetchV4ReservesWithTimeout` never rejects; failure path returns `source: 'none'` triggering Layer 3 stale.
> - `fetchMarketsData` now propagates actual `source` and uses `mapped.length > 0` for `v4Success`.
> - RPC path returns `spokeHubTopology: []` to preserve backend registry from version regression (AAV-581 decision).
> - `v4FallbackReserveIds` auto-populates in backend when `source === 'rpc'`.
> - Known accepted degradation: `spokeName`/`marketName` inconsistency during RPC fallback (tracked AAV-580).
>
> **2026-06-07 (AAV-569)**: Layer 1 fast-fail + Layer 2 defensive fallback.
> - `V4ChainsFetchError`: When V4 SDK `chains()` fails (GraphQL unreachable), skip all retries and return empty immediately (~0ms instead of 12s). Layer 2 RPC fallback starts without delay.
> - `fetchV4WithRetry` in `v4-retry.ts`: Extracted retry logic with fast-fail, `logFn` for observability, `V4RetryResult.lastError` for stack trace preservation.
> - `V4FetchResult` unified as canonical type in `v4-retry.ts` (was duplicated in 3 files).
> - `buildFallbackV4SpokeEntries()`: `getDefaultV4SpokeEntries()` never returns empty — defensive fallback from `DEFAULT_SPOKE_HUB_TOPOLOGY` when address-book is corrupted/missing.
> - Sub-issues: AAV-603 (Slice 1: fast-fail), AAV-604 (Slice 2: defensive fallback).

## Context

V4 SDK (`@aave/client-v4`) 偶发返回空数据集（AAV-388）。当前防御只有：

1. V4 SDK 内部 3 次 retry + backoff（已实现）
2. 35s per-side timeout（ADR-0020 引入）
3. backend per-side staleData 兜底（ADR-0020）

但 staleData 在 hardTtl 之外会失效。若 V4 SDK 长时间持续返回空（>= `marketsHardTtlMs`），V4 数据彻底丢失。需要一层**当前链上数据**的兜底来填补 SDK 长时间故障窗口。

PRD（AAV-388, doc c6ab55629364）方案：fetcher 包内 inline 直读 Hub+Spoke 合约，封装在新的 `@internal/aave-rpc-infra` 包内。

本 ADR 把三层兜底关系明确化为一个稳定契约。

## Decision

V4 数据获取按以下严格顺序降级：

```
                  ┌─────────────────────────────────────────────┐
                  │  fetchMarketsData (fetcher 层)              │
                  │                                             │
       Layer 1 →  │   V4 SDK fetch (35s timeout, v4-fetcher.ts) │
                  │     │                                       │
                  │     ├─ success: source='sdk'                │
                  │     └─ empty / fail / timeout               │
                  │            │                                │
       Layer 2 →  │            ▼                                │
                  │   RPC direct-chain (15s inline timeout)     │
                  │     │  - 来源: @internal/aave-rpc-infra     │
                  │     │  - Hub.getAssetCount + getAsset       │
                  │     │  - Spoke.getReserveData (Multicall3)  │
                  │     │  - 映射为 RuntimeReserveData          │
                  │     │                                       │
                  │     ├─ success: source='rpc'                │
                  │     └─ fail / timeout: V4 fresh = []        │
                  │                                             │
                  │   写入 _metadata.fetchResult.v4             │
                  └─────────────────┬───────────────────────────┘
                                    │
                                    ▼
                  ┌─────────────────────────────────────────────┐
                  │  marketsService.refreshMarketsSnapshot()    │
                  │  (backend 层)                                │
                  │                                             │
       Layer 3 →  │  mergeWithPartialStale(): per-side stale    │
                  │    - fetchResult.v4.success=false           │
                  │    - V4 fresh = [] → 用 staleV4Data 兜底    │
                  │      (受 marketsHardTtlMs 限制)             │
                  │                                             │
                  │  最终 merged = freshV3 + (V4 fresh OR stale)│
                  └─────────────────────────────────────────────┘
```

### Layer 2 实现规范

**包归属**：新建 `packages/aave-rpc-infra/`，与 `aave-fetcher` 平级。依赖方向：

```
shared-contracts ← aave-rpc-infra ← aave-fetcher ← backend
```

**接口**（deep module）：

```typescript
export function fetchV4ReservesViaRpc(
  chainId: number,
  hubAddress: string,
  spokeAddresses: string[],
  options?: { timeoutMs?: number; maxRetries?: number }
): Promise<{ reserves: RuntimeReserveData[]; errors: string[] }>;

export function fetchV4OraclePricesViaRpc(
  chainId: number,
  oracleAddress: string,
  reserveIds: bigint[],
  options?: { timeoutMs?: number }
): Promise<{ prices: Map<string, BigNumber>; errors: string[] }>;

export class ProviderPool { /* 从 backend 抽出 */ }
export function executeMulticall3<T>(...) { /* 从 backend 抽出 */ }
```

**触发位置**：`packages/aave-fetcher/src/index.ts` `fetchV4ReservesWithTimeout()` 内，SDK 返回空集或抛错时调用 `fetchV4ReservesViaRpc()`。

**timeout**：RPC inline 15s 独立（不消耗 V4 SDK 的 35s 预算）。最坏路径：V4 SDK 35s + RPC 15s = 50s < 60s outer，符合 `MARKETS_FETCH_TIMEOUT_MS` 物理硬 kill。

### Layer 3 不变

ADR-0020 已定义的 per-side staleData 逻辑保留。`fetchResult.v4.success=false` 触发 stale 兜底，与本层 RPC 路径独立。

### 标识：v4FallbackReserveIds

backend `MarketsSnapshot` 添加：

```typescript
interface MarketsSnapshot {
  // ...
  /** Reserve IDs whose data came from Layer 2 (RPC direct-chain) instead of Layer 1 (SDK). */
  v4FallbackReserveIds: string[];
  // (deficitFallbackReserveIds 已存在，不变)
}
```

API 暴露该字段，前端可据此显示「数据可能延迟」提示。模式同 `deficitFallbackReserveIds`。

注意：**不在** `RuntimeReserveData` 上加 `_fallbackSource` 字段（与 ADR-0019 决定一致：reserve 层保持纯净，per-reserve 元数据用 snapshot 级 ID 列表表达）。

## Alternatives Considered

### A. 只做 stale fallback（无 RPC 层）

- Pro：实现最简单（ADR-0020 已完成）
- Con：SDK 长时间故障（> hardTtl）下 V4 数据完全丢失
- Rejected as the only layer，作为 Layer 3 保留

### B. 只做 RPC fallback（无 stale 层）

- Pro：兜底数据新鲜度高
- Con：RPC 也偶发不稳定（onchainDataService 实测 ECONNRESET 频繁）；不解决 V3 单边失败问题
- Rejected as the only layer，作为 Layer 2 加入

### C. RPC fallback 嵌在 35s V4 timeout 内（剥夺 SDK 的 35s 后用剩余预算）

- Pro：总耗时不增加
- Con：SDK 拖到接近 35s 才失败时，RPC 几乎没预算可用，等于没有
- Rejected：选择 RPC 独立 15s timeout

### D. RPC 改为独立 cron（参考 onchainDataService 模式）

- Pro：完全脱离主刷新链路
- Con：需要额外 cron + cache 调度；和 ADR-0020 的 fresh/stale 模型耦合复杂
- Deferred 到 v0.2：v0.1 用 inline 模式快速上线

### E. 当前决策（三层独立、严格降级）

- Accepted

## Consequences

- **Positive**：V4 数据可用性显著提升：SDK 短时故障 → RPC 接管；SDK 长时故障 → stale 仍可在 TTL 内服务；RPC + stale 都失败才丢数据
- **Positive**：`@internal/aave-rpc-infra` 同时为 v0.2 `onchainDataService` 重构铺路（统一 RPC 基础设施）
- **Positive**：三层职责清晰，每层可独立单测/演练
- **Negative**：实现工作量增加（新建包、抽 ABI、Multicall3、retry + serial fallback）
- **Negative**：fetcher 包依赖增加（引入 `aave-rpc-infra` → 间接引入 `ethers`、`aave-address-book`）
- **Negative**：60s outer 物理兜底虽充足，但 v0.1 完全跑满最坏路径（35s + 15s = 50s）会推迟下游 cron tick；监控应观察 `fetchResult.v4.source==='rpc'` 频次

## References

- ADR-0019: protocolVersion Not in API（reserve 层不加 fallback 标记，本 ADR 沿用）
- ADR-0020: V3/V4 Concurrent Fetch + Per-Side Stale Merge（Layer 3）
- ADR-0022: Structured fetchResult Envelope（携带 `source` 字段表达层来源）
- Linear AAV-388: https://linear.app/aaveapy/issue/AAV-388
- Linear PRD (主方案): https://linear.app/aaveapy/document/prd-v4-sdk-fallback-direct-chain-read-when-sdk-returns-empty-c6ab55629364
- Existing RPC infra（待抽出）: `backend/src/services/onchainDataService.ts`, `backend/src/services/ethProviderService.ts`
