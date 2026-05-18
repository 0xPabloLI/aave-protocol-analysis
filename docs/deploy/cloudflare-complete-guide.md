# Cloudflare Workers & API Cache 完整指南

本文档整合了 Cloudflare Workers Browser Rendering、API 缓存策略和并发控制的完整配置指南。

## 目录

1. [架构概览](#1-架构概览)
2. [Browser Rendering 部署](#2-browser-rendering-部署)
3. [Worker API 接口](#3-worker-api-接口)
4. [API 缓存策略](#4-api-缓存策略)
5. [并发与速率控制](#5-并发与速率控制)
6. [Durable Objects（高级）](#6-durable-objects高级)
7. [故障排查](#7-故障排查)

---

## 1. 架构概览

### Browser Rendering 架构

```
Node.js 应用 (src/cloudflare-browser.ts)
    ↓ HTTP POST (scheduleDynamicSlot 控制频率 ≥21s)
Cloudflare Worker (workers/src/index.ts)
    ↓ Puppeteer API (scheduleLaunchSlot 控制频率 ≥20s)
Browser Instance/Session
```

### 优势

- ✅ 执行自定义 JavaScript
- ✅ 点击按钮和交互操作
- ✅ 提取动态内容（如 Campaign info 对话框）

---

## 2. Browser Rendering 部署

### 2.1 安装依赖

```bash
cd workers
npm install
```

### 2.2 登录 Cloudflare

```bash
npx wrangler login
```

### 2.3 部署 Worker

```bash
cd workers
npm run deploy
```

部署成功后会显示 Worker URL，例如：
```
https://aave-browser-rendering.your-subdomain.workers.dev
```

### 2.4 配置环境变量

在项目根目录 `.env` 文件中添加：

```bash
CLOUDFLARE_WORKER_URL=https://aave-browser-rendering.your-subdomain.workers.dev
```

### 2.5 测试

```bash
npm run dev
# 检查日志，应该看到 Cloudflare Worker 被调用
```

---

## 3. Worker API 接口

### 提取 Campaign Info

```json
POST https://your-worker-url.workers.dev
Content-Type: application/json

{
  "action": "extractCampaignInfo",
  "key": "celo-supply-usdt"
}
```

响应：
```json
{
  "success": true,
  "result": [
    {
      "action": "Supply USDT",
      "description": "Rewards are distributed using the following formula: ..."
    }
  ]
}
```

### 提取 Self Authentication 描述

```json
POST https://your-worker-url.workers.dev
Content-Type: application/json

{
  "action": "extractSelfAuth",
  "key": "celo-supply-usdt"
}
```

---

## 4. API 缓存策略

### 4.1 设计原则

- 前端 `staleTime` 定义**何时重新检查新鲜度**
- 重新检查应验证最新的源状态
- 未变更的响应仍应在带宽/延迟上节省成本

### 4.2 为什么不用全局 TTL

不同端点有不同的新鲜度需求：

| 端点类型 | 端点 | 新鲜度需求 |
|----------|------|-----------|
| **核心实时** | `/api/markets` | 每次 refetch 都应重新验证 |
| **侧数据** | `/api/meta/side-data` | 可容忍 TTL 缓存 |

### 4.3 后端 Header 策略

实现位置：`backend/src/middleware/cacheHeaders.ts`

| 类型 | 路径 | Cache-Control | 说明 |
|------|------|---------------|------|
| 核心实时 | `/api/markets*` | `no-cache, must-revalidate` + `ETag` | 条件请求 → 304 |
| 侧数据 | `/api/meta/side-data*` | `public, max-age=60, s-maxage=300, stale-while-revalidate=300` | 聚合 side-data，按最短子块 TTL（5 分钟） |
| 健康检查 | `/health`, `/api/health` | `no-store` | 不缓存 |

### 4.4 Cloudflare 规则配置

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

### 4.5 验证清单

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

---

## 5. 并发与速率控制

### 5.1 两层串行化

| 层级 | 函数 | 控制对象 | 间隔 |
|------|------|---------|------|
| Node.js 应用层 | `scheduleDynamicSlot` | 对 Worker 的 HTTP 请求 | ≥21s |
| Worker 内部 | `scheduleLaunchSlot` | Browser Instance 创建 | ≥20s |

### 5.2 Cloudflare 限制

**免费计划**：
- 每分钟最多创建 **3 个新浏览器实例**
- 计算：60 秒 ÷ 3 次 = **20 秒/次**

### 5.3 配置调整

**Worker 层**（wrangler.toml 或环境变量）：
```bash
BROWSER_MIN_LAUNCH_INTERVAL_MS=25000  # 25 秒（更保守）
```

**Node.js 层**（.env）：
```bash
CLOUDFLARE_DYNAMIC_MIN_INTERVAL_MS=25000  # 25 秒
```

### 5.4 重试机制

```typescript
// packages/aave-fetcher/src/merkl-api.ts
async function fetchWithRetry(url: string, label: string): Promise<Response> {
  // 最多重试 4 次
  // 等待时间：1s → 2s → 4s → 8s（指数退避）
  // 随机抖动：0-250ms（避免雷群效应）
}
```

---

## 6. Durable Objects（高级）

### 6.1 当前问题

- Worker 无状态，每次请求可能路由到不同实例
- Browser Session 存储在 Worker 内存中，无法跨实例共享
- 多个 Worker 实例可能同时创建 Browser Instance，触发限流

### 6.2 解决方案

使用 Durable Object 作为浏览器会话池管理器：

```
当前：
请求1 → Worker A → Browser Instance 1
请求2 → Worker B → Browser Instance 2  (可能触发限流)

优化后：
请求1 → Worker A → Durable Object → Browser Session 1
请求2 → Worker B → Durable Object → Browser Session 1 (复用)
```

### 6.3 实现示例

```typescript
// workers/src/browser-pool.ts
export class BrowserPool {
  private sessions: Map<string, any> = new Map();
  private lastLaunchAt: number = 0;
  
  async getBrowser(env: Env): Promise<any> {
    // 1. 尝试复用现有 session
    if (this.sessions.size > 0) {
      const sessionId = Array.from(this.sessions.keys())[0];
      return await puppeteer.connect(env.MY_BROWSER, sessionId);
    }
    
    // 2. 检查是否超过限流
    const now = Date.now();
    if (now - this.lastLaunchAt < 20000) {
      throw new Error('Rate limited');
    }
    
    // 3. 创建新 session
    const browser = await puppeteer.launch(env.MY_BROWSER, { keep_alive: 300000 });
    this.lastLaunchAt = now;
    return browser;
  }
}
```

配置 wrangler.toml：
```toml
[[durable_objects.bindings]]
name = "BROWSER_POOL"
class_name = "BrowserPool"
script_name = "aave-browser-rendering"
```

### 6.4 当前状态

目前代码**未使用 Durable Object**，而是：
- ✅ Worker 内部尝试复用 session（`puppeteer.sessions()`）
- ✅ 串行化 launch（`scheduleLaunchSlot`）
- ❌ 无法跨 Worker 实例共享 session

**建议**：如果遇到频繁的 429 错误，考虑实现 Durable Object 方案。

---

## 7. 故障排查

### Worker 部署失败

1. 检查登录状态：`npx wrangler whoami`
2. 检查 `wrangler.toml` 配置
3. 检查 Browser Rendering 权限

### Worker 返回错误

1. 查看实时日志：`npx wrangler tail`
2. 检查 `CLOUDFLARE_WORKER_URL` 环境变量
3. 验证 Worker URL 可访问性

### 429 速率限制

1. **短期**：保持当前设置，监控 429 错误
2. **中期**：实现 Durable Object 会话池
3. **长期**：升级到付费计划

### 成本

Workers Bindings 按浏览器使用时间计费：
- 每次请求启动一个浏览器实例
- 浏览器使用时间 = 页面加载时间 + 脚本执行时间
- 建议使用会话复用降低成本

---

## 总结

| 组件 | 配置 | 说明 |
|------|------|------|
| Worker 实例 | Cloudflare 自动扩展 | 无限制（受计划限制） |
| Browser Instance 创建 | `scheduleLaunchSlot` | 串行，≥20s 间隔 |
| Worker HTTP 请求 | `scheduleDynamicSlot` | 串行，≥21s 间隔 |
| Browser Session | `puppeteer.sessions()` | 尝试复用，但无法跨实例 |
| 核心 API 缓存 | `no-cache + ETag` | 每次验证，304 响应 |
| 侧数据 API 缓存 | TTL-based | 边缘缓存 5min-6h |
