# 数据新鲜度自动检查机制

## 概述

本系统实现了一套完整的数据新鲜度自动检查机制，确保前端始终获取最新的数据，无需手动触发刷新。

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
| `coingeckoFastFamily` | 10m | 其他 CoinGecko 快族 | 平衡新鲜度和配额。 |
| `coingeckoFdv` | 5m | FDV 缓存 | 与 FDV 预热 cron（每 5 分钟）一致，cron 与请求路径共用同一 TTL，过期才刷新。 |
| `coingeckoSlowFamily` | 6h | `coingeckoCategories`、`coingeckoFdvMonitor` | 低频元数据/监控，长 TTL 降低外部 API 压力。 |
| `merklMetrics*` | 5m~6h | `merklMetricsDefault/Min/Max/Empty` | 按指标节奏做有界动态 TTL。 |

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
    ├─ 否 → 直接返回缓存数据
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
3. **高可用性**：更新失败时仍可返回缓存数据
4. **简化 API**：移除专用刷新端点，API 更简洁
5. **智能调度**：定时任务作为后备，避免资源浪费

## 监控和日志

系统会输出详细的日志信息：

- `🔄 Data is stale, triggering automatic update...` - 触发自动更新
- `✅ Automatic update completed successfully` - 更新成功
- `❌ Automatic update failed` - 更新失败
- `⏳ Update already in progress, waiting...` - 等待更新完成
- `⚠️ Continuing with cached data after update failure` - 使用缓存数据

## 配置参数

可通过以下集中配置调整行为：

```typescript
// backend/src/cacheTtl.ts
BACKEND_CACHE_TTL_MS.marketsDataStaleThreshold;
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
