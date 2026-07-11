# ADR-0029: V4 数据获取弹性模式总览

Date: 2026-06-07
References: ADR-0020, ADR-0021, ADR-0027, AAV-569

## 状态

Accepted

## 上下文

V4 数据获取路径叠加了四种独立的弹性（resilience）模式，每种解决不同层面的不同问题。分散在多个 ADR 中，缺乏统一视角。新成员（或三个月后的自己）难以快速理解"为什么有这么多降级逻辑，各自在干什么"。

## 决策

将四种弹性模式统一为一篇参考文档，明确各自的**解决的问题、触发条件、状态模型、交互关系**。

### 模式总览

```
请求进入
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ 1. Fast-fail (AAV-569)                              │
│    判定 SDK 是否已死 → 跳过无效重试                     │
│    实现: V4ChainsFetchError → break retry loop        │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│ 2. Three-layer fallback (ADR-0021)                   │
│    SDK → RPC → Stale 严格降级                         │
│    Layer 1: V4 SDK (35s timeout)                     │
│    Layer 2: RPC 直读 Hub+Spoke 合约 (15s)            │
│    Layer 3: backend per-side stale (ADR-0020)         │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│ 3. ProviderPool endpoint suppression (ADR-0027/0028) │
│    RPC 端点级健康追踪 → 故障端点降权/恢复              │
│    实现: consecutiveFailures ≥ threshold → suppress   │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│ 4. Per-side partial stale merge (ADR-0020)           │
│    V3/V4 独立 stale → 单边失败不抹掉另一边             │
│    实现: mergeWithPartialStale() 纯函数               │
└─────────────────────────────────────────────────────┘
```

### 模式 1: Fast-fail

| 属性 | 值 |
|---|---|
| **解决的问题** | 延迟 — `chains()` 和 `reserves()` 共用同一 GraphQL endpoint，endpoint 挂了重试无意义 |
| **触发条件** | `chains()` 返回 `isErr()` → 抛 `V4ChainsFetchError` |
| **行为** | 跳过 3 次重试（原 2s+4s+6s=12s 延迟），立即返回空结果 |
| **状态模型** | 无状态 — 纯靠 error type 判别 |
| **实现位置** | `v4-errors.ts`（V4ChainsFetchError）、`v4-retry.ts`（fast-fail catch）、`v4-fetcher.ts`（throw on chains failure） |
| **副作用** | 无 — 其他 error type 仍走正常重试 |

**为什么不用 last-known-good？** Fast-fail 判定的是"当前请求不可能成功"，不是"我记得上次长什么样"。无状态、零内存、零过期问题。

### 模式 2: Three-layer fallback

| 属性 | 值 |
|---|---|
| **解决的问题** | 数据可用性 — V4 SDK 长时间宕机时仍能提供数据 |
| **触发条件** | Layer 1: SDK 空集或超时 → Layer 2: SDK 失败 → Layer 3: 所有层失败 |
| **行为** | 严格降级，每层独立 timeout（SDK 35s + RPC 15s = 50s < 60s 外层硬限制） |
| **状态模型** | 无状态（`source: 'sdk' | 'rpc' | 'none'` 标识来源，不跨周期持久化） |
| **实现位置** | `concurrent-fetch.ts`（协调层）、`aave-rpc-infra`（Layer 2 实现） |
| **副作用** | Layer 2 RPC 返回 `spokeHubTopology: []`（AAV-581 决策，避免拓扑降级） |

**降级路径的数据质量递减**：
- Layer 1 (SDK): 完整 reserve 数据 + spokeName + 激励
- Layer 2 (RPC): 链上合约直读，token 价格/激励缺失，spokeName 为 address-book key（如 `"MAIN_SPOKE"`）
- Layer 3 (Stale): 上次成功快照，可能过时

### 模式 3: ProviderPool endpoint suppression

| 属性 | 值 |
|---|---|
| **解决的问题** | RPC 端点可用性 — 避免重复请求已知故障的端点 |
| **触发条件** | 连续失败 ≥ `failureThreshold`（默认 2）→ suppress `suppressionMs`（默认 5min） |
| **行为** | Suppressed 端点降为最后备选；恢复后自动回到优先位 |
| **状态模型** | 有状态 — 每个端点维护 `consecutiveFailures`、`suppressedUntil`、`lastSuccessAt` |
| **实现位置** | `aave-rpc-infra/src/index.ts`（ProviderPool 类） |
| **副作用** | stale provider 定期驱逐（`providerTtlMs` = 30min），防止内存泄漏 |

**与 Layer 2 的关系**：ProviderPool 是 Layer 2 RPC fallback 的基础设施。当 Layer 2 触发 `fetchV4ReservesViaRpc` 时，每个 spoke 的 RPC 请求通过 `executeWithAutoRpc` 自动使用 ProviderPool 的健康排序和 suppression 逻辑。

### 模式 4: Per-side partial stale merge

| 属性 | 值 |
|---|---|
| **解决的问题** | 数据完整性 — V3 或 V4 单边失败不应抹掉另一边的新鲜数据 |
| **触发条件** | `fetchResult.v3.success` 或 `fetchResult.v4.success` 为 false |
| **行为** | 失败 side 用 stale 数据补位，成功 side 保留 fresh 数据 |
| **状态模型** | 有状态 — `staleV3Data`、`staleV4Data`、`v3FetchedAt`、`v4FetchedAt` 在 backend 内存中 |
| **实现位置** | `backend/src/services/marketsService.ts`（mergeWithPartialStale） |
| **副作用** | stale 受 `marketsHardTtlMs` 限制，超时后不再补位 |

**与 Three-layer 的关系**：Per-side stale merge 是 Three-layer 的 Layer 3 实现。Layer 2 (RPC) 也失败后，`fetchResult.v4.success = false`，触发 Layer 3 stale 补位。

### 模式间的交互关系

```
                         Fast-fail (1)
                             │
                    ┌────────┴────────┐
                    │ chains() fails?  │
                    │ → skip retries   │
                    └────────┬────────┘
                             │
                  Three-layer fallback (2)
                             │
              ┌──────────────┼──────────────┐
              │              │              │
         Layer 1: SDK   Layer 2: RPC   Layer 3: Stale
              │              │              │
              │    ┌─────────┴─────────┐   │
              │    │ ProviderPool (3)   │   │
              │    │ endpoint health    │   │
              │    │ + suppression      │   │
              │    └───────────────────┘   │
              │                            │
              └────────────┬───────────────┘
                           │
              Per-side stale merge (4)
              V3 stale ←→ V4 stale
              独立补位，互不覆盖
```

**关键设计原则**：

1. **每种模式只解决一个问题** — fast-fail 解决延迟，three-layer 解决可用性，ProviderPool 解决端点效率，per-side stale 解决数据完整性
2. **无共享可变状态**（除 ProviderPool 的端点健康和 backend 的 stale 缓存）— 模式间不互相依赖内部状态
3. **降级是单向的** — SDK → RPC → Stale，不会从 Stale 回退到 RPC
4. **每层独立 timeout** — 最坏路径总耗时可计算且可控

### 被否决的模式：Last-known-good spokeName cache

AAV-580 曾提出用 in-memory `spokeAddress → spokeName` 缓存解决 RPC fallback 期间 spokeName 不一致问题（`"MAIN_SPOKE"` vs `"Main"`）。经代码验证后否决：

- **激励匹配不受影响** — Merkl 用 `chainId + tokenAddress`，Merit V4 用 `chainName + tokenSymbol`，都不依赖 `marketName`
- **纯展示问题** — 仅在 SDK 宕机期间用户看到 address-book 风格名称，SDK 恢复后自动正确
- **代价不匹配** — 为极低概率的展示美化引入永久性 module 级可变状态 + 生命周期管理
- **与 fast-fail 理念冲突** — fast-fail 的核心是"无状态、靠 error type 判断"，引入 LKG cache 是另一套完全不同的弹性哲学

AAV-580 已取消，实现已 revert。

## 替代方案

### A. 将四种模式合并为单一状态机

Pro: 单一入口、状态转换明确
Con: 四种模式作用在不同层面（retry 决策 / 数据源 / 端点健康 / 数据合并），强行合并为状态机会导致层间耦合、无法独立测试
Rejected

### B. 统一为 circuit breaker 模式

Pro: 业界标准、库支持好（如 `opossum`）
Con: 四种模式的触发条件和恢复策略完全不同（error type / timeout / failure count / TTL），统一为 circuit breaker 的 open/half-open/closed 三态过于简化
Rejected

### C. 当前决策：各模式独立、文档统一

Accepted

## 后果

- **正面**: 新成员通过一篇文档即可理解全部弹性模式的设计意图和交互关系
- **正面**: 每种模式可独立演进（如 ProviderPool 加三态模型不影响 fast-fail 逻辑）
- **正面**: 明确了"不为展示美化引入有状态缓存"的设计原则
- **负面**: 四种模式的代码分散在 3 个包中（fetcher / rpc-infra / backend），需要跨包理解

## 参考

- ADR-0020: V3/V4 Concurrent Fetch + Per-Side Stale Merge
- ADR-0021: Three-Layer V4 Fallback
- ADR-0022: Structured fetchResult Envelope
- ADR-0027: Layered RPC Resolution
- ADR-0028: ProviderPool RPC Observability
- AAV-569: V4 chains() fast-fail + address-book defensive fallback
- AAV-580: spokeName/marketName inconsistency (Canceled)
