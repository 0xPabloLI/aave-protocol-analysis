# Cloudflare Workers Browser Rendering 设置指南

## 概述

我们已经将 Cloudflare Browser Rendering 从 REST API 迁移到 Workers Bindings + Puppeteer。这样可以：
- ✅ 执行自定义 JavaScript
- ✅ 点击按钮和交互操作
- ✅ 提取动态内容（如 Campaign info 对话框）

## 架构

```
Node.js 应用 (src/cloudflare-browser.ts)
    ↓ HTTP POST
Cloudflare Worker (workers/src/index.ts)
    ↓ Puppeteer
浏览器自动化 (点击按钮、提取数据)
```

## 部署步骤

### 1. 安装 Workers 依赖

```bash
cd workers
npm install
```

### 2. 登录 Cloudflare

```bash
npx wrangler login
```

这会打开浏览器，让你登录 Cloudflare 账户。

### 3. 部署 Worker

```bash
cd workers
npm run deploy
```

部署成功后会显示 Worker URL，例如：
```
https://aave-browser-rendering.your-subdomain.workers.dev
```

### 4. 配置环境变量

在项目根目录的 `.env` 文件中添加：

```bash
CLOUDFLARE_WORKER_URL=https://aave-browser-rendering.your-subdomain.workers.dev
```

### 5. 测试

运行你的应用：

```bash
npm run dev
```

检查日志，应该看到 Cloudflare Worker 被调用。

## Worker API

### 提取 Campaign Info

**请求**：
```json
POST https://your-worker-url.workers.dev
Content-Type: application/json

{
  "action": "extractCampaignInfo",
  "key": "celo-supply-usdt"
}
```

**响应**：
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

**请求**：
```json
POST https://your-worker-url.workers.dev
Content-Type: application/json

{
  "action": "extractSelfAuth",
  "key": "celo-supply-usdt"
}
```

**响应**：
```json
{
  "success": true,
  "result": "Supply USDT and double your yield by verifying your humanity..."
}
```

## 故障排查

### Worker 部署失败

1. 检查是否已登录：`npx wrangler whoami`
2. 检查 `wrangler.toml` 配置是否正确
3. 检查是否有 Browser Rendering 权限

### Worker 返回错误

1. 检查 Worker 日志：`npx wrangler tail`
2. 检查环境变量 `CLOUDFLARE_WORKER_URL` 是否正确
3. 检查 Worker URL 是否可访问

### 速率限制

Workers 也有速率限制，但比 REST API 更宽松：
- Free 计划：有使用限制
- Paid 计划：更高的限制

如果遇到 429 错误，需要：
1. 升级到 Paid 计划
2. 或者实现速率限制（在 Node.js 端）

## 成本

Workers Bindings 按浏览器使用时间计费：
- 每次请求会启动一个浏览器实例
- 浏览器使用时间 = 页面加载时间 + 脚本执行时间
- 建议使用会话复用（未来优化）

## 与 REST API 的对比

| 功能 | REST API | Workers Bindings |
|------|----------|------------------|
| 获取 HTML | ✅ | ✅ |
| 执行自定义脚本 | ❌ | ✅ |
| 点击按钮 | ❌ | ✅ |
| 交互操作 | ❌ | ✅ |
| 部署复杂度 | 简单 | 中等 |
| 成本 | 按请求 | 按浏览器时间 |

## 下一步优化

1. **会话复用**：使用 Durable Objects 复用浏览器会话，减少冷启动时间
2. **批量处理**：一次 Worker 调用处理多个 key
3. **缓存**：在 Worker 中实现结果缓存
