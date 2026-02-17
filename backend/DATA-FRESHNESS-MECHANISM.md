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
// 数据新鲜度阈值：1分钟
const STALE_THRESHOLD_MS = 1 * 60 * 1000;

// 检查数据是否过期
isStale(): boolean {
  const lastUpdated = this.getLastUpdated();
  if (!lastUpdated) return true;
  
  const now = new Date();
  const age = now.getTime() - lastUpdated.getTime();
  return age > STALE_THRESHOLD_MS;
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

#### 应用到所有 API 端点

所有数据读取端点都会自动调用此函数：

- `GET /api/markets` - 获取市场数据
- `GET /api/markets/stats` - 获取统计信息
- `GET /api/markets/chains` - 获取链列表
- `GET /api/markets/list` - 获取市场列表
- `GET /api/campaigns/:campaignId/forecast-state` - 获取单个 Merkl forecast state
- `GET /api/campaigns/forecast-states` - 批量获取 Merkl forecast states

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

可以通过修改以下常量来调整行为：

```typescript
// backend/src/services/dataService.ts
const STALE_THRESHOLD_MS = 1 * 60 * 1000; // 数据新鲜度阈值

// backend/src/controllers/marketsController.ts
await new Promise(resolve => setTimeout(resolve, 1000)); // 等待时间
```

## 向后兼容性

- 保留了 `updateStatus` 状态管理
- 保留了定时任务作为后备机制
- 数据格式完全兼容
