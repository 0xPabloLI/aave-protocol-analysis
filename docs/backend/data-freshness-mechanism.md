# 数据新鲜度与 TTL 配置指南

本文档整合了后端数据新鲜度机制、TTL 配置策略和缓存设计原则。

**与代码对齐**：行为描述以 `backend/src` 现行实现为准。通用模式另见 `docs/reusable/caching-data-freshness-patterns.md`（避免重复粘贴长模板）。
**命名说明**：内部常量与环境变量已统一为 `*_MAX_SERVE_STALE_MS`。

---

## 设计原则

### Freshness Terms

| Term | Meaning | Example |
|------|------|------|
| `writeInterval` | Producer or cron refresh cadence | markets cron every 1 min |
| `softTTL` | Age after which data is considered stale | `marketsDataStaleThreshold = 60s` |
| `maxServeStaleMs` | Oldest age allowed to serve | `marketsServeHardStaleMax = 5m` |
| `fallbackMode` | What happens when refresh fails | reuse previous snapshot / return error |

**Rule**: `softTTL` should fit the product's freshness tolerance. `writeInterval` is a refresh cadence, not a hard upper bound; some caches intentionally use a longer `softTTL` or `maxServeStaleMs` than the write cadence when best-effort cron is acceptable.

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

## Model

> 下表是唯一的 freshness source：它同时表达 endpoint、cache layer、`writeInterval`、`softTTL`、`maxServeStaleMs` 和 `fallbackMode`。

### Freshness Matrix

**Cache layer legend**

- 📸 In-memory snapshot: 整体组装状态，cron/startup 写入，API 只读
- 🗂️ Pure in-memory cache: 小型 keyed 缓存，lazy/on-demand 写入
- 📄 Runtime bridge file: 跨进程/重启的紧凑交接文件
- 🐛 Debug file: 详细调试产物，不在热路径

| Endpoint | Object | Cache layer | writeInterval | softTTL | hardTTL | fallbackMode | Notes |
|---|---|---|---|---|---|---|---|
| `GET /api/markets` | Markets snapshot | 📸 In-memory snapshot | `0 * * * * *` | `marketsDataStaleThreshold = 60s` | `marketsServeHardStaleMax = 5m` | 刷新失败保留上一轮快照；冷启动未预热则 `503 MARKETS_SNAPSHOT_NOT_READY`；超 hardTTL 返回 `503 MARKETS_SNAPSHOT_STALE` | `staleTimeMs` 只做前端提示 |
| `GET /api/markets` | On-chain per-pool cache | 🗂️ Pure in-memory cache | `10 * * * * *` | `onchainCacheTtl = 30m` | `onchainCacheTtl = 30m` | 过期条目不参与合并；缺失时回退 `deficit=0` + base rate 计算 | 仅影响 markets 合并字段 |
| `GET /api/meta/side-data` | Forecast snapshot | 📸 In-memory snapshot | `30 */10 * * * *` | `merklForecastResultDefault = 10m` | `MERKL_FORECAST_SNAPSHOT_MAX_SERVE_STALE_MS`（默认 `max(3x TTL, 30m)`） | 刷新失败时在窗口内复用上一轮 snapshot；无旧快照时返回 `503 FORECAST_SNAPSHOT_NOT_READY` | `forecast.staleTimeMs` = snapshot 发布节奏 |
| `GET /api/meta/side-data` | Forecast opportunity-meta cache | 🗂️ Pure in-memory cache + 📄 Runtime bridge file | on-demand + `merklForecastOpportunityMetaDefault = 5m` | `merklForecastOpportunityMetaDefault = 5m` | `MERKL_FORECAST_OPPORTUNITY_META_MAX_SERVE_STALE_MS`（默认 `max(3x TTL, 30m)`） | 先读 fresh lite file，再回退旧 cache | 供 forecast 计算和 runtime file 读取 |
| `GET /api/meta/side-data` | Categories cache | 🗂️ Pure in-memory cache | `10 0 */6 * * *` | `coingeckoLongDataTtlMs = 6h` | `COINGECKO_CATEGORIES_MAX_SERVE_STALE_MS`（默认 `max(3x TTL, 30m)`） | 刷新失败时在窗口内复用上一轮缓存；否则返回错误 | `categories.staleTimeMs` |
| `GET /api/meta/side-data` | FDV cache | 🗂️ Pure in-memory cache | `5 */5 * * * *` | `coingeckoFdv = 5m` | `COINGECKO_FDV_MAX_SERVE_STALE_MS`（默认 `max(3x TTL, 30m)`） | 刷新失败时在窗口内复用上一轮缓存；否则返回错误 | `fdv.staleTimeMs` |
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
| `BACKEND_CACHE_TTL_MS.marketsDataStaleThreshold` | 1m | 对外 staleTime | `GET /api/markets` 响应提示 | 软过期提示，不等于硬失败 |
| `BACKEND_CACHE_TTL_MS.marketsServeHardStaleMax` | 5m | 硬过期 | `GET /api/markets` 过旧则 503 | 防止无限期返回旧 markets 快照 |
| `BACKEND_CACHE_TTL_MS.onchainCacheTtl` | 30m | 缓存 TTL | on-chain per-pool 缓存 | RPC 失败时允许复用 |
| `BACKEND_CACHE_TTL_MS.merklForecastResultDefault` | 10m | 缓存 TTL / 对外 staleTime | forecast 结果快照 | 与 forecast cron 对齐 |
| `BACKEND_CACHE_TTL_MS.merklForecastOpportunityMetaDefault` | 5m | 缓存 TTL | forecast opportunity-meta 内存缓存 | 机会元数据更频繁刷新 |
| `BACKEND_CACHE_TTL_MS.merklLiteFileMaxAge` | 5m | 文件快照 TTL | `merkl-opportunity-meta-lite.json` 可接受年龄 | 超过则不再作为 fresh lite 文件 |
| `BACKEND_CACHE_TTL_MS.merklOpportunitiesDefault` | 5m | 缓存 TTL | Merkl opportunities 拉取缓存 | root 侧机会列表缓存 |
| `BACKEND_CACHE_TTL_MS.coingeckoLongDataTtlMs` | 6h | 缓存 TTL | CoinGecko categories + FDV parity monitor | 低频长周期数据 |
| `BACKEND_CACHE_TTL_MS.coingeckoFdv` | 5m | 缓存 TTL / 对外 staleTime | FDV 列表缓存 | 与 FDV 预热 cron 对齐 |
| `BACKEND_CACHE_TTL_MS.merklMetricsDefault` | 30m | 动态缓存默认 TTL | Merkl metrics 动态 TTL 的默认值 | cadence 识别失败时兜底 |
| `BACKEND_CACHE_TTL_MS.merklMetricsMin` | 10m | 动态缓存下限 | Merkl metrics 动态 TTL 下限 | 防止刷新过频 |
| `BACKEND_CACHE_TTL_MS.merklMetricsMax` | 6h | 动态缓存上限 | Merkl metrics 动态 TTL 上限 | 防止缓存过久 |
| `BACKEND_CACHE_TTL_MS.merklMetricsEmpty` | 10m | 空数据 TTL | metrics 无 dailyRewardsRecords 时的缓存 TTL | 仅作为首次冷启动/无旧缓存时的回退值 |

> 规则速记：`staleTime` 是给前端看的“建议刷新提示”；`TTL` 是缓存是否仍可复用；`hard stale` 是“过了就不该再服务”的边界；`cron` 是主动刷新节奏。三者不等价。

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
