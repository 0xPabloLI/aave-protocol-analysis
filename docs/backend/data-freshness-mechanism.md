# 数据新鲜度与 TTL 配置指南

本文档整合了后端数据新鲜度机制、TTL 配置策略和缓存设计原则。

**与代码对齐**：行为描述以 `backend/src` 现行实现为准。通用模式另见 `docs/reusable/caching-data-freshness-patterns.md`（避免重复粘贴长模板）。

---

## 设计原则

### 写入频率 vs 新鲜度窗口

| 概念 | 定义 | 示例 |
|------|------|------|
| **Write frequency** | 数据生产者的更新频率 | 因数据源而异（本仓库 markets 侧为 cron 每 1 分钟写入，与 `marketsDataStaleThreshold` 对齐） |
| **Freshness window** | 消费者可容忍的陈旧度 | 前端可接受 1 分钟延迟 |
| **TTL** | 缓存过期时间 | 根据两者决定 |

**原则**：`TTL ≤ min(write_frequency, freshness_window)`

### 选择 TTL 前先验证

- 检查 API 文档中的更新频率
- 采样观察实际时间戳间隔
- 记录决策理由

### 分层缓存架构

```
1. 内存运行时缓存  ← 最快，易失
2. 运行时快照文件  ← 持久化，快速读取
3. 在线缓存层      ← Redis/CDN
4. 上游 API        ← 最慢，权威
```

### 文件快照设计

- **Runtime 文件**：小巧、专用（如 `merkl-opportunity-meta-lite.json`）
- **Debug 文件**：可大、详细，不在热路径
- **原子写入**：`tmp` + `rename` 防止部分读取

---

## 概述

- **Markets** 与 **forecast（无 `ids` 的全量快照）**：定时任务 + 启动预热写入内存；**API 请求不触发**外部拉取。
- **CoinGecko categories / FDV**：cron 预热 + 内存缓存；缓存过期或无效时，**请求路径会触发**刷新（见 `coingeckoController`）。
- `/api/markets` 的 `staleTimeMs` 供前端提示；**markets 服务端不在请求路径上根据年龄触发刷新或阻塞等待刷新**。

## 核心特性（现行实现）

### 1. Markets（`marketsService` + `GET /api/markets`）

- **写入**：`node-cron` 每分钟第 0 秒调用 `refreshMarketsSnapshot()`；进程启动时 `warmMarketsCache()` 先填满快照再监听端口。
- **读取**：控制器只读内存快照；`getMarketsData()` 提供 `staleTimeMs`（=`marketsDataStaleThreshold`，默认 60s）与 `ageMs`（距上次成功拉取），**不**据此触发刷新。
- **并发**：`refreshMarketsSnapshot` 内用 `refreshInProgress` 合并并发刷新请求。

### 2. On-chain（`onchainDataService`）

- **写入**：独立 cron 每分钟第 10 秒刷新各池 RPC 数据；与 markets cron 分离。
- **缓存**：每池数据带时间戳，TTL 为 **`BACKEND_CACHE_TTL_MS.onchainCacheTtl`（默认 30 分钟）**；RPC 失败时在 TTL 内可复用缓存。
- **合并**：markets 刷新时从 on-chain 缓存合并 `deficit` / `baseVariableBorrowRate`；缺失时用占位/回退计算（见代码）。

### 3. 常量 `marketsServeHardStaleMax`（5 分钟）

- 在 `cacheTtl.ts` 中定义，表示 markets 快照在 HTTP 层允许服务的最大陈旧边界。
- 当前 `marketsController` 会在该阈值外返回 `503 MARKETS_SNAPSHOT_STALE`。

## 实现细节

### 数据服务层 (`marketsService.ts`)

**注意**: 原 `dataService.ts` 已删除，由 `marketsService.ts` 替代。现在使用 cron-write/API-read-only 模式：

```typescript
// marketsService.ts - 内存快照 + cron 刷新
let snapshot: MarketsSnapshot | null = null;

export async function refreshMarketsSnapshot(): Promise<MarketsSnapshot> {
  // ... cron 每分钟调用
  const payload = await fetchMarketsPayload();
  snapshot = { payload, fetchedAt: Date.now() };
  return snapshot;
}

export function getMarketsSnapshot(): MarketsSnapshot | null {
  return snapshot;  // API 只读，从不触发刷新
}
```

### 控制器层 (`marketsController.ts`)

现在使用纯读取模式（cron-write/API-read-only）：

```typescript
export async function getMarkets(req: Request, res: Response): Promise<void> {
  const { payload, staleTimeMs } = getMarketsData();
  if (!payload) {
    res.status(503).json({ errorCode: 'MARKETS_SNAPSHOT_NOT_READY', ... });
    return;
  }
  res.json({ snapshot: { lastUpdated, version: 'markets-v2', staleTimeMs }, reserves });
}
```

前端若需要市场筛选列表，应从 `GET /api/markets` 的 `reserves` 中去重推导 `{ marketName, chainName }`。

**数据从哪来**：`refreshMarketsSnapshot()` 调用根目录打包的 `fetchMarketsPayload()`（`dist/index.js`），在进程内拉取 Aave + 激励并返回内存结构；**不**通过读取 `data/debug/aave-formatted-data.full.json` 提供 API。该文件仍由单独跑根目录 fetcher 时落盘，供文件落地、调试或与旧流程对齐。

**激励拉取容错**：`fetchMarketsPayload()` 在 `src/index.ts` 中对 Merit、Merkl、Brevis **并发**拉取；单路失败时记日志并降级为**空索引**，不阻断整轮返回。**仅当 Aave 市场数据（`fetchAaveMarketData`）失败时**，整轮 `fetchMarketsPayload` 抛错，本轮不更新内存 `snapshot`（若已有历史快照则 API 仍可读上一轮）。链上 `deficit` / `baseVariableBorrowRate` 不在此阶段打 RPC，而在 `marketsService` 写入时从 `onchainDataService` 缓存合并（见上文「On-chain」）。

### 路由层 (`routes/markets.ts`)

无专用刷新端点；markets 仅依赖 cron + 启动预热。

### 定时任务 (`updateScheduler.ts`)

| 任务 | Cron（秒级） | 说明 |
|------|----------------|------|
| Markets | `0 * * * * *` | 每分钟第 0 秒 |
| On-chain | `10 * * * * *` | 每分钟第 10 秒 |
| FDV | `5 */5 * * * *` | 每 5 分钟 |
| Forecast | `30 */10 * * * *` | 每 10 分钟第 30 秒 |
| Categories | `10 0 */6 * * *` | 每 6 小时 |

## 统一时间配置（TTL / timeout / schedule / rate-limit）

统一入口：
- `backend/src/cacheTtl.ts`
- `backend/src/config.ts`（CoinGecko 重试/退避默认值读取共享常量）

### TTL 分桶（同源优先）

| Family | 值 | 作用范围 | 说明 |
|---|---:|---|---|
| `marketsDataStaleThreshold` | 60s | `GET /api/markets` `staleTimeMs` | 与 `GET /api/markets` 的 `staleTimeMs` 一致；**非**服务端请求触发刷新。 |
| `onchainCacheTtl` | 30m | on-chain per-pool cache | RPC 失败时在 TTL 内复用缓存；cron 仍每分钟尝试刷新。 |
| `merklForecastResult` | 10m | `merklForecastResultDefault` | 与 `merklMetricsMin` 对齐，底层 metrics 不会更快更新。 |
| `merklForecastMeta` | 5m | `merklForecastOpportunityMetaDefault`、`merklLiteFileMaxAge`、`merklOpportunitiesDefault` | 元数据查询可更频繁。 |
| `marketsServeHardStaleMax` | 5m | `GET /api/markets` 硬过期上限 | 快照超出该值返回 `MARKETS_SNAPSHOT_STALE`（503）。 |
| `coingeckoFdv` | 5m | FDV 缓存 | 与 FDV 预热 cron（每 5 分钟）一致。 |
| `coingeckoLongDataTtlMs` | 6h | Categories 与 FDV 监控 | 低频元数据/监控，长 TTL 降低外部 API 压力。 |
| `merklMetrics*` | 10m~6h | `merklMetricsDefault/Min/Max/Empty` | 按指标节奏做有界动态 TTL（clamp 范围统一为 10m~6h）。 |

### 端点对外 staleTimeMs 与内部 TTL 对齐表

> 这一节确保前端 `staleTime` 与后端实际刷新频率一致。

| 端点 | 对外 staleTimeMs | 内部缓存 TTL | 数据源更新频率 | 对齐状态 |
|------|-----------------|-------------|---------------|---------|
| `GET /api/markets` | 60s | 60s | 60s cron | ✓ (含 on-chain 数据) |
| `GET /api/meta/side-data`（`forecast` 子块） | 10m（forecast 子块） | snapshotCache (cron 写入) | 10m cron | ✓ cron-write/API-read-only |
| `GET /api/coingecko-fdv` | 5m | 5m | 5m cron | ✓ |
| `GET /api/coingecko-categories` | 6h | 6h | 6h cron | ✓ |
| `GET /api/meta/side-data` | 按子块各自 TTL | categories 6h / fdv 5m / forecast 10m | 聚合 | ✓ 子块独立 |

### Merkl Metrics 动态 TTL 说明

**Per-campaign（每个活动一条缓存）**：`merklForecastService` 里 `metricsCache` 为 `Map<campaignId, ...>`。**每个 campaign 的 TTL 单独计算**——只用**该 id** 返回的 `dailyRewardsRecords` 推 cadence，因此 **不同 campaign 的 metrics 拉取间隔可以不一样**（都在 `[merklMetricsMin, merklMetricsMax]` 内）。与 `campaignOpportunityCache`（整表、约 5 分钟）是两套独立缓存。

```
观测 dailyRewardsRecords 时间戳间隔 → 取中位数作为 cadence
→ TTL = cadence / 4（保守策略）
→ clamp 到 [merklMetricsMin=10m, merklMetricsMax=6h]
→ 空数据时用 merklMetricsEmpty=10m（与 min 一致）
```

**与 forecast cron 的关系**：cron 每 10 分钟重算 `snapshotCache` 时，会对每个 campaign 调用 `getMerklForecastState`；若某 campaign 的 metrics **仍在 TTL 内**，则**不会**再次请求 Merkl metrics，该次快照仍用缓存中的序列参与 `distributedSoFar` 等计算。详见 `docs/api/api-documentation.md` → **Opportunity 元数据与 metrics 的缓存节奏**。

### 按端点汇总：软过期 / 硬过期 / 回退策略

> 这一节是“运营视角”的配置表，用来快速理解每个接口在**数据变旧**和**刷新失败**时的行为；所有数值都来自当前代码实现（`cacheTtl.ts` + 各 controller/service）。

| 接口 | 主要数据 | 软过期阈值（Soft） | 硬过期 / 最大陈旧（Hard） | 过期时行为 | 刷新失败时行为 |
|---|---|---|---|---|---|
| `GET /api/markets` | Aave markets 快照 + on-chain merge | 响应 `staleTimeMs` = 1m（提示用） | 硬过期上限 `marketsServeHardStaleMax = 5m`；超期返回 `503 MARKETS_SNAPSHOT_STALE` | 请求**不**触发刷新；由 cron 每分钟刷新快照。On-chain 字段依赖独立 cron + **30m** TTL 缓存。 | `fetchMarketsPayload` 抛错时本轮不更新 `snapshot`，仍返回上一轮成功快照（若存在）；冷启动仍返回 `MARKETS_SNAPSHOT_NOT_READY`，超过硬过期返回 `MARKETS_SNAPSHOT_STALE`。 |
| `GET /api/meta/side-data` 的 `forecast` 子块 | Merkl campaign forecast 状态 | **cron-write/API-read-only**：cron 每 10 分钟刷新 `snapshotCache`；公开 API 聚合读取该快照，**不触发** Merkl API 调用 | fallback 最大陈旧由 `MERKL_FORECAST_SNAPSHOT_FALLBACK_MAX_STALE_MS` 控制（默认 `max(3x TTL, 30m)`） | 若 forecast 快照未填充则返回空 snapshot + warn（在 side-data 中体现为 forecast 子块内容）；其余子块不受影响。 | "部分失败"通过 errors[] 表达（整体 200）；刷新失败时在 fallback 窗口内复用旧快照，超窗后返回空 snapshot。 |
| `GET /api/coingecko-categories` | `stablecoins / ETH` 符号集合 | `BACKEND_CACHE_TTL_MS.coingeckoLongDataTtlMs = 6h` | 同一数值视为最大陈旧；过期则尝试刷新 | 缓存未过 6h：直接返回缓存；超过 6h：通过 `fetchJsonWithRetry` 串行请求 5 个 CoinGecko 分类页并更新缓存（有 rate limit & 指数退避）。 | 若刷新失败，且在 `COINGECKO_CATEGORIES_FALLBACK_MAX_STALE_MS` 内有旧缓存则回退；否则返回错误。 |
| `GET /api/coingecko-fdv` | FDV 列表（CEX 代币 FDV） | `BACKEND_CACHE_TTL_MS.coingeckoFdv = 5m` | 同一数值视为最大陈旧；过期即必须刷新，同时要求所有条目 `fdvUsd !== null` | 缓存未过 5m 且没有 `fdvUsd = null`：直接返回缓存；过期或含 null：强制刷新，先尝试 CoinMarketCap，再回退 CoinGecko FDV。 | 若刷新结果为空，优先在 `COINGECKO_FDV_FALLBACK_MAX_STALE_MS`（默认 `max(3x TTL, 30m)`）内回退旧缓存；若外部都失败且无可回退旧值，返回错误。 |
| `GET /api/health` / `GET /health` | 健康检查（环境 & 配置摘要） | 无 | 无 | 实时构造 JSON 返回，不做缓存或 TTL 判断。 | N/A（只要进程还活着基本能返回 200；严重错误才会 500）。 |

> 前端的 `staleTime` 可与各端点 `staleTimeMs` 对齐（如 markets 1m、forecast 10m）。`marketsServeHardStaleMax` 用于 HTTP 层硬过期边界。 

### 最差可服务新鲜度（Worst-case 可回退窗口）

说明：这列出“接口在不触发 `500` 的前提下，仍能被返回（含 fallback）”的最坏陈旧上限。

| 接口 | 最差可服务新鲜度（最坏情况） | 主要控制点 |
|---|---:|---|
| `GET /api/markets` | `5m` (`marketsServeHardStaleMax`) | `marketsService.getMarketsData()` 超过此值返回 `503`（`MARKETS_SNAPSHOT_STALE`） |
| `GET /api/meta/side-data`（`forecast`） | `max(MERKL_FORECAST_SNAPSHOT_FALLBACK_MAX_STALE_MS, 10m)`；默认 `30m` | `refreshForecastSnapshotCache()` 的 previous snapshot fallback |
| `GET /api/meta/side-data`（`categories`） | `max(COINGECKO_CATEGORIES_FALLBACK_MAX_STALE_MS, 6h)`；默认 `18h` | `getOrRefreshCoingeckoCategoriesData()` 的 empty-result fallback |
| `GET /api/meta/side-data`（`fdv`） | `max(COINGECKO_FDV_FALLBACK_MAX_STALE_MS, 5m)`；默认 `30m` | `getOrRefreshFdvData()` 的 stale/null/empty fallback |
| `GET /api/meta/side-data`（任一子块失败） | `N/A`（聚合层返回 `partial=true`） | 失败子块通过 `errors` 暴露，其余子块仍返回 |

> 注意：`side-data` 是聚合端点，最终对外感知是否“可用”需按子块分解；整体 `max age` 取决于最慢可恢复子块。

### 非 TTL 但已收敛的时间配置

- `MARKETS_FETCH_TIMEOUT_MS`（`marketsService.ts`，markets 单次拉取超时，默认 60s）
- `BACKEND_SCHEDULE_CRON.marketsBackupEveryMinuteAtSecond0`（`0 * * * * *`）
- `coingeckoFetchConfig.maxDelayMs` 默认（60 秒）
- `coingeckoFetchConfig.rateLimitMinWaitSeconds` 默认（60 秒）
- `MERKL_FETCH_MAX_CONCURRENCY` 默认 5（`packages/aave-shared-config` 全进程 Merkl 出站并发池）
- `merklFetchConfig.maxRetries` 默认 3（指数退避重试）
- `merklFetchConfig.baseDelayMs` 默认 1 秒 / `maxDelayMs` 默认 10 秒

说明：上述为超时/调度/限流，不属于快照 freshness TTL，但已和 TTL 一样走统一时间常量管理。

### Merkl API Rate Limit & 并发控制

**官方限制**（[docs.merkl.xyz](https://docs.merkl.xyz/integrate-merkl/app#api-rate-limit)）：
- 默认 **10 requests/second**
- 可通过申请自定义 API Key（`X-API-Key` header）提升限额

**本项目策略**：

Forecast cron 刷新时会为每个 campaign 并发请求 `campaigns/{id}` + `campaigns/{id}/metrics`，campaign 数量 30+ 时瞬间并发可达 60+，远超限制导致 `ECONNRESET`。

解决方案（`packages/aave-shared-config` 的 `createMerklConcurrencyLimitedFetch` + `merklForecastService` 重试）：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `MERKL_FETCH_MAX_CONCURRENCY` | 5 | 单进程内所有 Merkl HTTP（opportunities 分页、campaign/metrics、merit 侧 Merkl 等）共享的在途请求上限 |
| `MERKL_FETCH_MAX_RETRIES` | 3 | 瞬态错误（ECONNRESET / 429 / 5xx）最大重试次数 |
| `MERKL_FETCH_BASE_DELAY_MS` | 1000 | 指数退避起始延迟 |
| `MERKL_FETCH_MAX_DELAY_MS` | 10000 | 指数退避最大延迟 |

重试覆盖的错误类型：`ECONNRESET`、`ETIMEDOUT`、`UND_ERR_SOCKET`（Node undici）、HTTP 429、HTTP 5xx。
非瞬态错误（如 404）不重试，直接抛出。

## 请求路径简图（markets）

```
Cron / startup warmup → refreshMarketsSnapshot() → 内存 snapshot
GET /api/markets      → 只读 snapshot（不触发 fetch）
GET /api/meta/side-data → 聚合读取 categories / fdv / forecast 内部缓存
```

## 配置参数（入口）

```typescript
// backend/src/cacheTtl.ts
BACKEND_CACHE_TTL_MS.*;
BACKEND_SCHEDULE_CRON.*;

// backend/src/config.ts — CoinGecko / Merkl 重试与限流
coingeckoFetchConfig.*;
merklFetchConfig.*;
```

## 监控与日志

以各服务实际 `logger` 输出为准（如 markets 刷新 `🔄` / `✅`、Merkl forecast 错误日志等）。**不存在**已废弃的「请求触发自动更新」类日志文案。
