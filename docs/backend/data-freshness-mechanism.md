# 数据新鲜度自动检查机制

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

### 数据服务层 (`dataService.ts`)

```typescript
import { BACKEND_CACHE_TTL_MS } from '../cacheTtl.js';

// 检查数据是否过期
isStale(): boolean {
  const lastUpdated = this.getLastUpdated();
  if (!lastUpdated) return true;
  
  const now = new Date();
  const age = now.getTime() - lastUpdated.getTime();
  return age > BACKEND_CACHE_TTL_MS.marketsDataStaleThreshold;
}
```

### 控制器层 (`marketsController.ts`)

#### 核心函数：`checkAndUpdateDataIfStale()`

```typescript
async function checkAndUpdateDataIfStale(): Promise<void> {
  const isStale = dataService.isStale();
  const currentStatus = getUpdateStatus();
  
  // 数据过期且无更新进行中 → 触发更新
  if (isStale && currentStatus.status !== 'updating') {
    // 设置更新状态（锁）
    setUpdateStatus({ status: 'updating', ... });
    
    try {
      // 执行数据更新
      await fetchAaveMarketsData();
      await dataService.refreshCache();
      
      // 更新成功，释放锁
      setUpdateStatus({ status: 'idle', ... });
    } catch (error) {
      // 更新失败，记录错误
      setUpdateStatus({ status: 'error', ... });
    }
  } 
  // 已有更新进行中 → 等待
  else if (currentStatus.status === 'updating') {
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
| `realtimeFamily` | 60s | `marketsDataStaleThreshold`、`rate-inputs`、`merklLiteFileMaxAge`、`merklForecastResultDefault`、`merklForecastOpportunityMetaDefault`、`merklOpportunitiesDefault` | 同一快照新鲜度族，统一 60 秒避免跨接口不同步。 |
| `marketsServeStaleMax` | 5m | `/api/markets` hard stale cap | 超过该值返回 `503`，避免长期返回旧快照。 |
| `coingeckoFastFamily` | 10m | 其他 CoinGecko 快族 | 平衡新鲜度和配额。 |
| `coingeckoFdv` | 5m | FDV 缓存 | 与 FDV 预热 cron（每 5 分钟）一致，cron 与请求路径共用同一 TTL，过期才刷新。 |
| `coingeckoSlowFamily` | 6h | `coingeckoCategories`、`coingeckoFdvMonitor` | 低频元数据/监控，长 TTL 降低外部 API 压力。 |
| `merklMetrics*` | 5m~6h | `merklMetricsDefault/Min/Max/Empty` | 按指标节奏做有界动态 TTL。 |

### 按端点汇总：软过期 / 硬过期 / 回退策略

> 这一节是“运营视角”的配置表，用来快速理解每个接口在**数据变旧**和**刷新失败**时的行为；所有数值都来自当前代码实现（`cacheTtl.ts` + 各 controller/service）。

| 接口 | 主要数据 | 软过期阈值（Soft） | 硬过期 / 最大陈旧（Hard） | 过期时行为 | 刷新失败时行为 |
|---|---|---|---|---|---|
| `GET /api/markets` | Aave markets 快照（`markets-v2`） | `BACKEND_CACHE_TTL_MS.marketsDataStaleThreshold = 1m` | `BACKEND_CACHE_TTL_MS.marketsServeStaleMax = 5m` | 超过 1m 视为 stale，`checkAndUpdateDataIfStale()` 触发更新（scheduler 或按需）；只要快照年龄在 5m 以内，仍继续返回当前缓存数据。 | 如果更新失败或超时，状态标记为 `error`，**继续使用旧快照**；一旦快照年龄超过 5m，直接返回 `503`，拒绝再用旧快照（`errorCode = "MARKETS_SNAPSHOT_HARD_STALE"`）。 |
| `GET /api/rate-inputs` | 利率输入 / 储备参数 | `RATE_INPUTS_TTL_MS = BACKEND_CACHE_TTL_MS.realtimeFamily = 1m` | `RATE_INPUTS_MAX_STALE_MS = BACKEND_CACHE_TTL_MS.rateInputsServeStaleMax = 5m` | 首次请求或 `>5m`：同步刷新快照（阻塞直到拿到最新或失败）；`1m~5m`：直接返回旧快照，同时在后台触发一次刷新。 | 软过期场景（1m~5m）如果后台刷新失败，仅记录 `warn`，客户端继续拿到旧数据；硬过期场景（>5m）如果同步刷新失败，controller 抛错，最终返回 `500`（**不会回退到更旧的快照**）。 |
| `GET /api/campaigns/forecast-states` | Merkl campaign forecast 状态 | 结果缓存 `FORECAST_CACHE_TTL_MS` 默认 `1m`（可由 env 覆盖）；Merkl metrics 动态 TTL 由 `METRICS_CACHE_*` 控制（10m~6h） | 无单独“硬过期编码”，上限由 Merkl metrics TTL 约束 | 单个 campaign 命中缓存则直接返回；缓存过期则重新从 Merkl API / 本地 lite 文件计算。 | “部分失败”通过响应体里的 `errors[]` 表达（整体仍是 200）；只有极端情况（如本地 markets 缓存损坏）才会抛到顶层返回 `500`，没有针对年龄的 503 逻辑。 |
| `GET /api/coingecko-categories` | `stablecoins / ETH` 符号集合 | `BACKEND_CACHE_TTL_MS.coingeckoCategories = 6h` | 同一数值视为最大陈旧；过期即必须刷新 | 缓存未过 6h：直接返回缓存；超过 6h：通过 `fetchJsonWithRetry` 串行请求 5 个 CoinGecko 分类页并更新缓存（有 rate limit & 指数退避）。 | 如果刷新期间所有重试都失败，内部抛错，controller 返回 `500`；**不会在 TTL 过期后回退使用旧缓存**（即使内存中仍有旧值）。 |
| `GET /api/coingecko-fdv` | FDV 列表（CEX 代币 FDV） | `BACKEND_CACHE_TTL_MS.coingeckoFdv = 5m` | 同一数值视为最大陈旧；过期即必须刷新，同时要求所有条目 `fdvUsd !== null` | 缓存未过 5m 且没有 `fdvUsd = null`：直接返回缓存；过期或含 null：强制刷新，先尝试 CoinMarketCap，再回退 CoinGecko FDV。 | 若 CMC 和 CoinGecko 都失败，刷新 promise 抛错，controller 返回 `500`；**不会在 TTL 过期后继续用旧 FDV 缓存**。 |
| `GET /api/health` / `GET /health` | 健康检查（环境 & 配置摘要） | 无 | 无 | 实时构造 JSON 返回，不做缓存或 TTL 判断。 | N/A（只要进程还活着基本能返回 200；严重错误才会 500）。 |

> 前端的 `staleTime` 应当与“软过期阈值”对齐：例如 `/api/markets` 与 `/api/rate-inputs` 统一为 1 分钟；而硬过期（如 markets 5 分钟）主要用于防止后端“无限期兜底旧快照”，正常流量下不应触发。

### 非 TTL 但已收敛的时间配置

- `BACKEND_TIMEOUT_MS.update`（3 分钟）
- `BACKEND_SCHEDULE_CRON.eachMinuteAtSecondZero`（`0 * * * * *`）
- `coingeckoFetchConfig.maxDelayMs` 默认（60 秒）
- `coingeckoFetchConfig.rateLimitMinWaitSeconds` 默认（60 秒）

说明：上述为超时/调度/限流，不属于快照 freshness TTL，但已和 TTL 一样走统一时间常量管理。

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
