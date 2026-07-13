# 数据新鲜度与 TTL 配置指南

本文档整合了后端数据新鲜度机制、TTL 配置策略和缓存设计原则。

**与代码对齐**：行为描述以 `backend/src` 现行实现为准。通用模式另见 `docs/reusable/caching-data-freshness-patterns.md`（避免重复粘贴长模板）。
**命名说明**：内部常量与环境变量已统一为 `*_SOFT_TTL_MS` / `*_HARD_TTL_MS`。

---

## 设计原则

> 通用缓存与新鲜度模式（四层架构、原子写入、状态机、HTTP 缓存头等）见 `docs/reusable/caching-data-freshness-patterns.md`。本文档只记录**本项目特有的**术语、策略与配置。

### Freshness Terms

| Term | Meaning | Example |
|------|------|------|
| `writeInterval` | Producer or cron refresh cadence | markets cron every 1 min |
| `softTTL` | Age after which data is considered stale (still served, marked stale) | `marketsSoftTtlMs = 60s` |
| `hardTTL` | Oldest age allowed to serve; beyond this, reject or return error | `marketsHardTtlMs = 5m` |
| `singleTTL` | Single hard boundary with fallback defaults (no soft/hard split) | `onchainTtlMs = 30m` |
| `fallbackMode` | What happens when refresh fails | reuse previous snapshot / return error / use defaults |

**Rule**: `softTTL` should fit the product's freshness tolerance. `writeInterval` is a refresh cadence, not a hard upper bound.

**本项目使用的两种 TTL 模式**：

| Pattern | Behavior | When to use |
|---|---|---|
| **soft/hard 两级** | soft 内正常返回；soft~hard 间返回旧数据+标记 stale；hard 外拒绝服务 (503/null) | 公开 API 需要向调用方暴露陈旧程度（如 markets 的 `staleTimeMs`） |
| **单 TTL+兜底** | TTL 内用缓存；过期直接丢弃，用安全默认值填充 | 内部缓存有可靠默认值，不需要向调用方暴露陈旧状态（如 on-chain per-pool） |

> **共同前提**：两者都是 **cron-write / API-read-only** 模式（请求不触发刷新）。区别仅在过期后的处理策略。

On-chain data (`deficit`, `baseVariableBorrowRate`) 使用**单 TTL+兜底**模式：过期条目直接从结果中排除，markets 层自动补默认值（`deficit="0"`，利率可计算时照算），不需要区分 soft/hard。

### 选择 TTL 前先验证

- 检查 API 文档中的更新频率
- 采样观察实际时间戳间隔
- 记录决策理由

### 分层缓存架构与文件快照

本项目遵循 `docs/reusable/caching-data-freshness-patterns.md` 中的四层服务链与文件快照规范：

- **分层**：内存运行时缓存 → 运行时快照文件 → 在线缓存层（Redis/CDN）→ 上游 API
- **文件快照**：Runtime 文件小巧专用（如 `merkl-opportunity-meta-lite.json`）；Debug 文件详细但不在热路径；原子写入采用 `tmp` + `rename`

---

## Model

> 下表是唯一的 freshness source：它同时表达 endpoint、cache layer、`writeInterval`、`softTTL`、`hardTTL` 和 `fallbackMode`。

### Freshness Matrix

**Cache layer legend**

- 📸 In-memory snapshot: 整体组装状态，cron/startup 写入，API 只读
- 🗂️ Pure in-memory cache: 小型 keyed 缓存，lazy/on-demand 写入
- 📄 Runtime bridge file: 跨进程/重启的紧凑交接文件
- 🐛 Debug file: 详细调试产物，不在热路径

| Endpoint | Object | Cache layer | writeInterval | softTTL | hardTTL | fallbackMode | Notes |
|---|---|---|---|---|---|---|---|
| `GET /api/markets` | Markets snapshot | 📸 In-memory snapshot | `0 * * * * *` | `marketsSoftTtlMs = 60s` | `marketsHardTtlMs = 5m` | 刷新失败保留上一轮快照；冷启动未预热则 `503 MARKETS_SNAPSHOT_NOT_READY`；超 hardTTL 返回 `503 MARKETS_SNAPSHOT_STALE` | `staleTimeMs` 只做前端提示 |
| `GET /api/markets` | On-chain per-pool cache | 🗂️ Pure in-memory cache | `10 * * * * *` | — (单TTL) | **singleTTL = 30m** (`onchainTtlMs`) | 过期条目不参与合并；缺失时回退 `deficit=0` + base rate 计算 | 单TTL+兜底模式，无soft/hard分级；仅影响 markets 合并字段 |
| `GET /api/meta/side-data` | Forecast snapshot | 📸 In-memory snapshot | `30 */10 * * * *` | `merklForecastResultDefault = 10m` | `MERKL_FORECAST_SNAPSHOT_HARD_TTL_MS`（默认 `max(3x TTL, 30m)`） | 刷新失败时在窗口内复用上一轮 snapshot；无旧快照时返回 `503 FORECAST_SNAPSHOT_NOT_READY` | `forecast.staleTimeMs` = snapshot 发布节奏 |
| `GET /api/meta/side-data` | Forecast opportunity-meta cache | 🗂️ Pure in-memory cache + 📄 Runtime bridge file | on-demand + `merklForecastOpportunityMetaDefault = 5m` | `merklForecastOpportunityMetaDefault = 5m` | `MERKL_FORECAST_OPPORTUNITY_META_HARD_TTL_MS`（默认 `max(3x TTL, 30m)`） | 先读 fresh lite file，再回退旧 cache | 供 forecast 计算和 runtime file 读取 |
| `GET /api/meta/side-data` | Categories cache | 🗂️ Pure in-memory cache | `10 0 */6 * * *` | `coingeckoLongDataTtlMs = 6h` | `COINGECKO_CATEGORIES_HARD_TTL_MS`（默认 `max(3x TTL, 30m)`） | 刷新失败时在窗口内复用上一轮缓存；否则返回错误 | `categories.staleTimeMs` |
| `GET /api/meta/side-data` | FDV cache | 🗂️ Pure in-memory cache | `5 */5 * * * *` | `coingeckoFdv = 5m` | `COINGECKO_FDV_HARD_TTL_MS`（默认 `max(3x TTL, 30m)`） | 刷新失败时在窗口内复用上一轮缓存；否则返回错误 | `fdv.staleTimeMs` |
| `GET /api/meta/side-data` | Merkl metrics cache | 🗂️ Pure in-memory cache | on-demand dynamic TTL | `merklMetricsMin/Default/Max` | `merklMetricsMin/Default/Max` | per-campaign cadence detection；空结果优先复用上一轮非空缓存，超出硬上限才报错；**零基线（无 dailyRewardsRecords）最多容忍 30h（`merklForecastZeroBaselineMaxAgeMs = oneDay + sixHours`），超限后 campaign 从 forecast items 中排除** | `metricsCache` 按 campaignId 分桶 |

> 说明：`fallbackMode` 已包含刷新失败时行为，`hardTTL` 是最终拒绝服务边界。

## Non-freshness Timing

统一入口：
- `backend/src/cacheTtl.ts`
- `backend/src/config.ts`（CoinGecko 重试/退避默认值读取共享常量）

- `MARKETS_FETCH_TIMEOUT_MS`（`marketsService.ts`，markets 单次拉取超时，默认 60s）
- `BACKEND_SCHEDULE_CRON.marketsBackupEveryMinuteAtSecond0`（`0 * * * * *`）
- `coingeckoFetchConfig.maxDelayMs` 默认（60 秒）
- `coingeckoFetchConfig.rateLimitMinWaitSeconds` 默认（60 秒）
- `MERKL_FETCH_MAX_CONCURRENCY` 默认 5（`packages/aave-shared-config` 全进程 Merkl 出站并发池）
- `merklFetchConfig.maxRetries` 默认 3（指数退避重试）
- `merklFetchConfig.baseDelayMs` 默认 1 秒 / `maxDelayMs` 默认 10 秒

说明：上述为超时/调度/限流，不属于 freshness 语义，但已和时间常量统一管理。

### `backend/src/cacheTtl.ts` 全量索引

> 这一节把 `cacheTtl.ts` 里的**全部时间常量**一次列清，避免只看到对外 `staleTimeMs` 而忽略它们在缓存、重试、调度里的真实用途。

| 常量 | 值 | 类型 | Cache 层次 | 用处 | 备注 |
|---|---:|---|---|---|---|
| `BACKEND_TIME_MS.oneMinute` | 60s | 基础时间单位 | — | 作为 markets TTL、on-chain cron、部分调度的基准 | 最常用的最小粒度 |
| `BACKEND_TIME_MS.fiveMinutes` | 5m | 基础时间单位 | — | FDV TTL、Merkl 机会元数据 TTL、市场硬过期上限 | 也是若干 fallback 默认值来源 |
| `BACKEND_TIME_MS.tenMinutes` | 10m | 基础时间单位 | Merkl forecast 结果 TTL、Merkl metrics 最小 TTL、forecast cron | forecast 主节奏 |
| `BACKEND_TIME_MS.thirtyMinutes` | 30m | 基础时间单位 | on-chain per-pool TTL、Merkl metrics 默认/空数据 TTL 的下限之一 | 典型“可容忍较旧缓存”窗口 |
| `BACKEND_TIME_MS.sixHours` | 6h | 基础时间单位 | CoinGecko 长周期数据 TTL、Merkl metrics 最大 TTL | 低频元数据/监控 |
| `BACKEND_TIME_MS.oneDay` | 24h | 基础时间单位 | 预留通用单位 | 当前未直接被 `BACKEND_CACHE_TTL_MS` 消费 |
| `BACKEND_TIME_SECONDS.oneMinute` | 60s | 基础时间单位 | 纯秒级配置/文档对齐 | 目前主要是辅助常量 |
| `BACKEND_FETCH_TIMING_MS.coingeckoBaseDelay` | 1000ms | 重试/退避 | CoinGecko 重试退避基准 | 影响 `coingeckoFetchConfig` 默认值 |
| `BACKEND_FETCH_TIMING_MS.coingeckoMinRequestInterval` | 2500ms | 限流 | CoinGecko 请求间隔下限 | 防止触发 30 req/min 限流 |
| `BACKEND_FETCH_TIMING_MS.coingeckoMinRequestIntervalFloor` | 1000ms | 限流下限 | CoinGecko 请求间隔的最小安全下限 | 保护配置异常 |
| `BACKEND_FETCH_TIMING_MS.merklRetryBaseDelay` | 1000ms | 重试/退避 | Merkl 瞬态错误指数退避起点 | 供 Merkl fetch 重试逻辑使用 |
| `BACKEND_FETCH_TIMING_MS.merklRetryMaxDelay` | 10000ms | 重试/退避 | Merkl 瞬态错误指数退避上限 | 限制最大等待 |
| `BACKEND_SCHEDULE_CRON.marketsBackupEveryMinuteAtSecond0` | `0 * * * * *` | 调度 | markets 每分钟第 0 秒刷新 | 对应 `refreshMarketsSnapshot()` |
| `BACKEND_SCHEDULE_CRON.onchainDataWarmEveryMinuteAtSecond10` | `10 * * * * *` | 调度 | on-chain 每分钟第 10 秒刷新 | 与 markets 分开，避免抢占 |
| `BACKEND_SCHEDULE_CRON.coingeckoFdvWarmEveryFiveMinutesAtSecond5` | `5 */5 * * * *` | 调度 | FDV 每 5 分钟预热 | 与 `coingeckoFdv` TTL 对齐 |
| `BACKEND_SCHEDULE_CRON.coingeckoCategoriesWarmEverySixHoursAtSecond10` | `10 0 */6 * * *` | 调度 | Categories 每 6 小时预热 | 与 `coingeckoLongDataTtlMs` 对齐 |
| `BACKEND_SCHEDULE_CRON.campaignForecastWarmEveryTenMinutesAtSecond30` | `30 */10 * * * *` | 调度 | Forecast 每 10 分钟刷新 | 与 `merklForecastResultDefault` 对齐 |
| `BACKEND_CACHE_TTL_MS.marketsSoftTtlMs` | 1m | 对外 staleTime | `GET /api/markets` 响应提示 | 软过期提示，不等于硬失败 |
| `BACKEND_CACHE_TTL_MS.marketsHardTtlMs` | 5m | 硬过期 | `GET /api/markets` 过旧则 503 | 防止无限期返回旧 markets 快照 |
| `BACKEND_CACHE_TTL_MS.onchainTtlMs` | 30m | 单TTL（hard边界+兜底） | on-chain per-pool 缓存 | 过期条目直接排除，markets层补默认值；无soft/hard分级 |
| `BACKEND_CACHE_TTL_MS.merklForecastResultDefault` | 10m | 缓存 TTL / 对外 staleTime | forecast 结果快照 | 与 forecast cron 对齐 |
| `BACKEND_CACHE_TTL_MS.merklForecastOpportunityMetaDefault` | 5m | 缓存 TTL | forecast opportunity-meta 内存缓存 | 机会元数据更频繁刷新 |
| `BACKEND_CACHE_TTL_MS.merklLiteFileMaxAge` | 5m | 文件快照 TTL | `merkl-opportunity-meta-lite.json` 可接受年龄 | 超过则不再作为 fresh lite 文件 |
| `BACKEND_CACHE_TTL_MS.merklOpportunitiesDefault` | 5m | 缓存 TTL | Merkl opportunities 拉取缓存 | root 侧机会列表缓存 |
| `BACKEND_CACHE_TTL_MS.coingeckoLongDataTtlMs` | 6h | 缓存 TTL | CoinGecko categories + FDV parity monitor | 低频长周期数据 |
| `BACKEND_CACHE_TTL_MS.coingeckoFdv` | 5m | 缓存 TTL / 对外 staleTime | FDV 列表缓存 | 与 FDV 预热 cron 对齐 |
| `BACKEND_CACHE_TTL_MS.merklMetricsDefault` | 30m | 动态softTTL默认值 | Merkl metrics 动态 TTL 的默认值 | cadence 识别失败时兜底；内部派生 hardTTL = max(soft×3, 30m) |
| `BACKEND_CACHE_TTL_MS.merklMetricsMin` | 10m | 动态缓存下限 | Merkl metrics 动态 TTL 下限 | 防止刷新过频 |
| `BACKEND_CACHE_TTL_MS.merklMetricsMax` | 6h | 动态缓存上限 | Merkl metrics 动态 TTL 上限 | 防止缓存过久 |
| `BACKEND_CACHE_TTL_MS.merklMetricsEmpty` | 10m | 空数据 TTL | metrics 无 dailyRewardsRecords 时的缓存 TTL | 仅作为首次冷启动/无旧缓存时的回退值 |

### `MERKL_TTL` / `COINGECKO_TTL` — 派生 TTL 常量

> 从 `BACKEND_CACHE_TTL_MS` 派生的最终 TTL 值，各 service/controller 仅 import 使用。hardTTL 统一由 `max(softTTL × 3, 30min)` 派生。

| 常量 | 值 | 来源 | 消费者 |
|---|---:|---|---|
| `MERKL_TTL.forecastResultSoftTtlMs` | 10m | `merklForecastResultDefault` | `merklForecastService.ts` → 导出 `FORECAST_SOFT_TTL_MS` |
| `MERKL_TTL.forecastOpportunityMetaSoftTtlMs` | 5m | `merklForecastOpportunityMetaDefault` | `merklForecastService.ts` |
| `MERKL_TTL.forecastOpportunityMetaHardTtlMs` | 15m | max(5m×3, 30m) | `merklForecastService.ts` |
| `MERKL_TTL.metricsSoftTtlMs` | 30m | `merklMetricsDefault` | `merklForecastService.ts` |
| `MERKL_TTL.metricsHardTtlMs` | 90m | max(30m×3, 30m) | `merklForecastService.ts` |
| `MERKL_TTL.forecastSnapshotHardTtlMs` | 30m | max(10m×3, 30m) | `merklForecastController.ts` |
| `MERKL_TTL.opportunitiesSoftTtlMs` | 5m | `merklOpportunitiesDefault` | `merklOpportunityClient.ts` |
| `COINGECKO_TTL.categoriesSoftTtlMs` | 6h | `coingeckoLongDataTtlMs` | `coingeckoController.ts` |
| `COINGECKO_TTL.categoriesHardTtlMs` | 18h | max(6h×3, 30m) | `coingeckoController.ts` |
| `COINGECKO_TTL.fdvSoftTtlMs` | 5m | `coingeckoFdv` | `coingeckoController.ts` |
| `COINGECKO_TTL.fdvHardTtlMs` | 15m | max(5m×3, 30m) | `coingeckoController.ts` |

> 规则速记：`staleTime` 是给前端看的"建议刷新提示"；`softTTL` 是软过期（视为陈旧但仍可服务）；`hardTTL` 是"过了就不该再服务"的边界；`singleTTL` 是单一边界+兜底默认值模式（如 onchain）；`cron` 是主动刷新节奏。所有 TTL 值为纯常量（`cacheTtl.ts`），各文件仅 import。hardTTL 默认从 softTTL 动态派生：`max(softTTL × 3, 30min)`。

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

以各服务实际 `logger` 输出为准（如 markets 刷新 `🔄` / `✅`、Merkl forecast 错误日志等）。
