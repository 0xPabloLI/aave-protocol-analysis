# Cloudflare API 缓存策略

> **历史变更**：本文原为「Cloudflare Workers & API Cache 完整指南」。Merit 全链路（含
> Cloudflare Browser Rendering Worker）已于 2026-09 下线（AAV-1289），Worker 部署 /
> Worker API / 并发串行化 / Durable Objects 章节随之移除。现仅保留仍生效的 **API 缓存
> 与边缘缓存策略**部分（原第 4 章）。

## API 缓存策略

### 1 设计原则

- 前端 `staleTime` 定义**何时重新检查新鲜度**
- 重新检查应验证最新的源状态
- 未变更的响应仍应在带宽/延迟上节省成本

### 2 为什么不用全局 TTL

不同端点有不同的新鲜度需求：

| 端点类型     | 端点                  | 新鲜度需求                |
| ------------ | --------------------- | ------------------------- |
| **核心实时** | `/api/markets`        | 每次 refetch 都应重新验证 |
| **侧数据**   | `/api/meta/side-data` | 可容忍 TTL 缓存           |

### 3 后端 Header 策略

实现位置：`backend/src/middleware/cacheHeaders.ts`

| 类型     | 路径                     | Cache-Control                                                  | 说明                                     |
| -------- | ------------------------ | -------------------------------------------------------------- | ---------------------------------------- |
| 核心实时 | `/api/markets*`          | `no-cache, must-revalidate` + `ETag`                           | 条件请求 → 304                           |
| 侧数据   | `/api/meta/side-data*`   | `public, max-age=60, s-maxage=300, stale-while-revalidate=300` | 聚合 side-data，按最短子块 TTL（5 分钟） |
| 健康检查 | `/health`, `/api/health` | `no-store`                                                     | 不缓存                                   |

### 4 Cloudflare 规则配置

创建两个有序规则：

**规则 1: `bypass-core-realtime-api`（最高优先级）**

- 匹配：`/api/markets*`
- 动作：`Bypass cache`

**规则 2: `cache-side-data-api`**

- 匹配：`/api/meta/side-data*`
- 动作：`Eligible for cache`, `Edge TTL: Respect origin`, `Browser TTL: Respect origin`

额外配置：

- 启用 Brotli 压缩（Speed/Optimization）
- 避免对核心实时 API 使用 `Cache Everything`
- 引入新规则后执行一次缓存清除

### 5 验证清单

```bash
# 1. 压缩验证
curl -I -H 'Accept-Encoding: br,gzip' https://<api-host>/api/markets
# 期望：Content-Encoding: br 或 gzip

# 2. 核心重验证
curl -I https://<api-host>/api/markets
# 期望：Cache-Control: no-cache, must-revalidate 和 ETag

# 3. 304 行为
# 使用上次的 ETag 发送 If-None-Match
# 期望：未变更时返回 304

# 4. 侧数据边缘缓存
curl -I https://<api-host>/api/meta/side-data
# 多次请求后期望：CF-Cache-Status: HIT
```
