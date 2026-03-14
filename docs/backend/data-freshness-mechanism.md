# 数据新鲜度与 TTL 配置指南

本文档整合了后端数据新鲜度机制、TTL 配置策略和缓存设计原则。

---

## 设计原则

### 写入频率 vs 新鲜度窗口

| 概念 | 定义 | 示例 |
|------|------|------|
| **Write frequency** | 数据生产者的更新频率 | 上游 API 每 5 分钟更新 |
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

本系统实现了一套完整的数据新鲜度自动检查机制，确保前端始终获取最新的数据，无需手动触发刷新。**前端请求不会“强制”后端刷新**：后端按自身节奏（请求时检查 + 定时任务，如每分钟）决定是否更新，不依赖前端调用专用刷新接口。

## 核心特性

### 1. 自动数据新鲜度检查

- **时间窗口**：1分钟
- **检查时机**：每次 API 请求时自动检查
- **更新策略**：如果数据超过1分钟，自动触发更新并等待完成后返回最新数据

### 2. 并发控制机制

- **状态锁**：使用 `updateStatus` 作为全局锁，防止并发更新
- **状态类型**：
  - `idle`：空闲状态，可以触发新的更新
  - `updating`：更新中，阻止重复更新
  - `error`：更新失败，记录错误信息

### 3. 智能等待机制

- 如果检测到已有更新在进行中，等待1秒让更新完成
- 避免返回过期数据，提升用户体验

### 4. 错误处理

- 更新失败时返回缓存数据，不中断服务
- 记录详细错误日志，便于排查问题
- 保持服务可用性

### 5. Hard Stale Guard（防止无限返回旧数据）

- `/api/markets` 在返回数据前会检查快照年龄
- 当 `snapshotAgeMs > BACKEND_CACHE_TTL_MS.marketsServeStaleMax`（默认 5 分钟）时，返回 `503`，不再继续返回过旧缓存
- 响应包含 `errorCode: "MARKETS_SNAPSHOT_HARD_STALE"`、`lastSuccessfulUpdate`、`snapshotAgeMs`、`maxAllowedStaleMs` 便于告警和排查

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
  const { payload, staleTimeMs, ageMs } = getMarketsData();
  
  // 快照尚未就绪（冷启动）→ 返回 503
  if (!payload) {
    res.status(503).json({ errorCode: 'MARKETS_SNAPSHOT_NOT_READY', ... });
    return;
  }
  
  // 直接返回快照数据，无需检查过期或触发刷新
  res.json({ snapshot: { ... }, reserves: filteredData });
}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
```

#### 调用此函数的端点

仅以下**市场数据**相关端点会调用 `checkAndUpdateDataIfStale()`，并在数据过期时触发刷新：

- `GET /api/markets` - 获取市场数据

前端若需要市场筛选列表，应从 `GET /api/markets` 的 `reserves` 中去重推导 `{ marketName, chainName }`，而不是再读取第二个市场列表快照。

其他端点使用各自的新鲜度策略，不触发市场数据刷新：
- `GET /api/campaigns/forecast-states` - 使用市场缓存数据与 Merkl 服务，不调用本函数
- `GET /api/coingecko-categories` / `GET /api/coingecko-fdv` - 自有 TTL 与缓存
- `GET /api/rate-inputs` - 自有 TTL（与市场数据同族），不触发市场刷新

### 路由层 (`routes/markets.ts`)

**移除了专用刷新端点**：

```typescript
// ❌ 已移除
// router.post('/refresh', refreshMarkets);

// ✅ 所有数据刷新都通过常规 API 请求自动触发
```

### 定时任务 (`updateScheduler.ts`)

定时任务现在作为**后备机制**：

- 每1分钟检查一次数据新鲜度
- 如果数据已经是新鲜的（被 API 请求更新过），跳过更新
- 只在没有 API 请求时作为兜底保障

## 统一时间配置（TTL / timeout / schedule / rate-limit）

统一入口：
- `backend/src/cacheTtl.ts`
- `backend/src/config.ts`（CoinGecko 重试/退避默认值读取共享常量）

### TTL 分桶（同源优先）

| Family | 值 | 作用范围 | 说明 |
|---|---:|---|---|
| `realtimeFamily` | 60s | `marketsDataStaleThreshold`、`rate-inputs` | markets 和 rate-inputs 统一 60 秒。 |
| `merklForecastResult` | 10m | `merklForecastResultDefault` | 与 `merklMetricsMin` 对齐，底层 metrics 不会更快更新。 |
| `merklForecastMeta` | 5m | `merklForecastOpportunityMetaDefault`、`merklLiteFileMaxAge`、`merklOpportunitiesDefault` | 元数据查询可更频繁。 |
| `marketsServeStaleMax` | 5m | `/api/markets` hard stale cap | 超过该值返回 `503`，避免长期返回旧快照。 |
| `coingeckoFdv` | 5m | FDV 缓存 | 与 FDV 预热 cron（每 5 分钟）一致。 |
| `coingeckoSlowFamily` | 6h | `coingeckoCategories`、`coingeckoFdvMonitor` | 低频元数据/监控，长 TTL 降低外部 API 压力。 |
| `merklMetrics*` | 10m~6h | `merklMetricsDefault/Min/Max/Empty` | 按指标节奏做有界动态 TTL（clamp 范围统一为 10m~6h）。 |

### 端点对外 staleTimeMs 与内部 TTL 对齐表

> 这一节确保前端 `staleTime` 与后端实际刷新频率一致。

| 端点 | 对外 staleTimeMs | 内部缓存 TTL | 数据源更新频率 | 对齐状态 |
|------|-----------------|-------------|---------------|---------|
| `GET /api/markets` | 60s | 60s | 60s cron | ✓ |
| `GET /api/rate-inputs` | 60s | snapshot (cron 写入) | 60s cron | ✓ cron-write/API-read-only |
| `GET /api/campaigns/forecast-states` | 10m | snapshotCache (cron 写入) | 10m cron | ✓ cron-write/API-read-only |
| `GET /api/coingecko-fdv` | 5m | 5m | 5m cron | ✓ |
| `GET /api/coingecko-categories` | 6h | 6h | 6h cron | ✓ |
| `GET /api/meta/side-data` | 按子块各自 TTL | categories 6h / fdv 5m / forecast 10m | 聚合 | ✓ 子块独立 |

### Merkl Metrics 动态 TTL 说明

```
观测 dailyRewardsRecords 时间戳间隔 → 取中位数作为 cadence
→ TTL = cadence / 4（保守策略）
→ clamp 到 [merklMetricsMin=10m, merklMetricsMax=6h]
→ 空数据时用 merklMetricsEmpty=10m（与 min 一致）
```

### 按端点汇总：软过期 / 硬过期 / 回退策略

> 这一节是“运营视角”的配置表，用来快速理解每个接口在**数据变旧**和**刷新失败**时的行为；所有数值都来自当前代码实现（`cacheTtl.ts` + 各 controller/service）。

| 接口 | 主要数据 | 软过期阈值（Soft） | 硬过期 / 最大陈旧（Hard） | 过期时行为 | 刷新失败时行为 |
|---|---|---|---|---|---|
| `GET /api/markets` | Aave markets 快照（`markets-v2`） | `BACKEND_CACHE_TTL_MS.marketsDataStaleThreshold = 1m` | `BACKEND_CACHE_TTL_MS.marketsServeStaleMax = 5m` | 超过 1m 视为 stale，`checkAndUpdateDataIfStale()` 触发更新（scheduler 或按需）；只要快照年龄在 5m 以内，仍继续返回当前缓存数据。 | 如果更新失败或超时，状态标记为 `error`，**继续使用旧快照**；一旦快照年龄超过 5m，直接返回 `503`，拒绝再用旧快照（`errorCode = "MARKETS_SNAPSHOT_HARD_STALE"`）。 |
| `GET /api/rate-inputs` | 利率输入 / 储备参数 | **cron-write/API-read-only**：cron 每 1 分钟刷新 snapshot；API **不触发**外部调用 | 无硬过期限制 | API 请求直接返回 snapshot；若缓存未填充（冷启动 warmup 前）则返回空数组 + warn。 | cron 刷新失败仅记录 warn，继续用旧 snapshot。 |
| `GET /api/campaigns/forecast-states` | Merkl campaign forecast 状态 | **cron-write/API-read-only**：cron 每 10 分钟刷新 `snapshotCache`；API **不触发** Merkl API 调用 | 无；服务启动时预热缓存 | API 请求直接返回 snapshotCache；若缓存未填充则返回空 snapshot + warn。 | "部分失败"通过 errors[] 表达（整体 200）；cron 刷新失败仅记录 warn，继续用旧 snapshot。 |
| `GET /api/coingecko-categories` | `stablecoins / ETH` 符号集合 | `BACKEND_CACHE_TTL_MS.coingeckoCategories = 6h` | 同一数值视为最大陈旧；过期即必须刷新 | 缓存未过 6h：直接返回缓存；超过 6h：通过 `fetchJsonWithRetry` 串行请求 5 个 CoinGecko 分类页并更新缓存（有 rate limit & 指数退避）。 | 如果刷新期间所有重试都失败，内部抛错，controller 返回 `500`；**不会在 TTL 过期后回退使用旧缓存**（即使内存中仍有旧值）。 |
| `GET /api/coingecko-fdv` | FDV 列表（CEX 代币 FDV） | `BACKEND_CACHE_TTL_MS.coingeckoFdv = 5m` | 同一数值视为最大陈旧；过期即必须刷新，同时要求所有条目 `fdvUsd !== null` | 缓存未过 5m 且没有 `fdvUsd = null`：直接返回缓存；过期或含 null：强制刷新，先尝试 CoinMarketCap，再回退 CoinGecko FDV。 | 若 CMC 和 CoinGecko 都失败，刷新 promise 抛错，controller 返回 `500`；**不会在 TTL 过期后继续用旧 FDV 缓存**。 |
| `GET /api/health` / `GET /health` | 健康检查（环境 & 配置摘要） | 无 | 无 | 实时构造 JSON 返回，不做缓存或 TTL 判断。 | N/A（只要进程还活着基本能返回 200；严重错误才会 500）。 |

> 前端的 `staleTime` 应当与“软过期阈值”对齐：例如 `/api/markets` 与 `/api/rate-inputs` 统一为 1 分钟，`/api/campaigns/forecast-states` 为 10 分钟（与 metricsMin 对齐）；而硬过期（如 markets 5 分钟）主要用于防止后端“无限期兜底旧快照”，正常流量下不应触发。

### 非 TTL 但已收敛的时间配置

- `BACKEND_TIMEOUT_MS.update`（3 分钟）
- `BACKEND_SCHEDULE_CRON.eachMinuteAtSecondZero`（`0 * * * * *`）
- `coingeckoFetchConfig.maxDelayMs` 默认（60 秒）
- `coingeckoFetchConfig.rateLimitMinWaitSeconds` 默认（60 秒）
- `merklFetchConfig.maxConcurrency` 默认 5（并发限制）
- `merklFetchConfig.maxRetries` 默认 3（指数退避重试）
- `merklFetchConfig.baseDelayMs` 默认 1 秒 / `maxDelayMs` 默认 10 秒

说明：上述为超时/调度/限流，不属于快照 freshness TTL，但已和 TTL 一样走统一时间常量管理。

### Merkl API Rate Limit & 并发控制

**官方限制**（[docs.merkl.xyz](https://docs.merkl.xyz/integrate-merkl/app#api-rate-limit)）：
- 默认 **10 requests/second**
- 可通过申请自定义 API Key（`X-API-Key` header）提升限额

**本项目策略**：

Forecast cron 刷新时会为每个 campaign 并发请求 `campaigns/{id}` + `campaigns/{id}/metrics`，campaign 数量 30+ 时瞬间并发可达 60+，远超限制导致 `ECONNRESET`。

解决方案（`merklForecastService.ts` / `config.ts`）：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `MERKL_FETCH_MAX_CONCURRENCY` | 5 | 同时在途的 Merkl API 请求数（留一半给 opportunities 等其他调用） |
| `MERKL_FETCH_MAX_RETRIES` | 3 | 瞬态错误（ECONNRESET / 429 / 5xx）最大重试次数 |
| `MERKL_FETCH_BASE_DELAY_MS` | 1000 | 指数退避起始延迟 |
| `MERKL_FETCH_MAX_DELAY_MS` | 10000 | 指数退避最大延迟 |

重试覆盖的错误类型：`ECONNRESET`、`ETIMEDOUT`、`UND_ERR_SOCKET`（Node undici）、HTTP 429、HTTP 5xx。
非瞬态错误（如 404）不重试，直接抛出。

## 工作流程

```
用户请求 API
    ↓
检查数据新鲜度
    ↓
数据是否过期？
    ├─ 否 → 检查是否超过 hard stale 上限？
    |       ├─ 否 → 返回缓存数据
    |       └─ 是 → 返回 503（拒绝过旧快照）
    └─ 是 → 检查是否有更新进行中？
            ├─ 是 → 等待1秒
            └─ 否 → 触发更新
                    ↓
                设置状态为 updating（加锁）
                    ↓
                执行数据更新
                    ↓
                更新成功？
                ├─ 是 → 刷新缓存，设置状态为 idle
                └─ 否 → 记录错误，设置状态为 error
                    ↓
                返回数据给前端
```

## 优势

1. **用户体验优化**：前端无需手动刷新，始终获取最新数据
2. **性能优化**：避免不必要的重复更新
3. **高可用性 + 正确性平衡**：短时更新失败仍可返回缓存，超过 hard stale 上限后拒绝返回过旧数据
4. **简化 API**：移除专用刷新端点，API 更简洁
5. **智能调度**：定时任务作为后备，避免资源浪费

## 监控和日志

系统会输出详细的日志信息：

- `🔄 Data is stale, triggering automatic update...` - 触发自动更新
- `✅ Automatic update completed successfully` - 更新成功
- `❌ Automatic update failed` - 更新失败
- `⏳ Update already in progress, waiting...` - 等待更新完成
- `⚠️ Continuing with cached data after update failure` - 使用缓存数据
- `❌ Refusing to serve hard-stale markets snapshot` - 超过 hard stale 上限，拒绝返回旧快照

## 配置参数

可通过以下集中配置调整行为：

```typescript
// backend/src/cacheTtl.ts
BACKEND_CACHE_TTL_MS.marketsDataStaleThreshold;
BACKEND_CACHE_TTL_MS.marketsServeStaleMax;
BACKEND_CACHE_TTL_MS.coingeckoFdv;
BACKEND_CACHE_TTL_MS.coingeckoSlowFamily;
BACKEND_TIMEOUT_MS.update;
BACKEND_SCHEDULE_CRON.eachMinuteAtSecondZero;
BACKEND_FETCH_TIMING_MS.coingeckoBaseDelay;
BACKEND_FETCH_TIMING_MS.coingeckoMinRequestInterval;

// backend/src/config.ts
coingeckoFetchConfig.maxDelayMs;
coingeckoFetchConfig.rateLimitMinWaitSeconds;
coingeckoFetchConfig.minRequestIntervalMs;
```

## 向后兼容性

- 保留了 `updateStatus` 状态管理
- 保留了定时任务作为后备机制
- 数据格式完全兼容
