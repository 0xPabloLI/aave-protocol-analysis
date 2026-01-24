# Cloudflare Workers Browser Rendering

这个 Worker 使用 Cloudflare Workers Bindings + Puppeteer 来执行浏览器自动化任务，可以：
- 点击按钮
- 执行自定义 JavaScript
- 提取动态内容

## 部署步骤

### 1. 安装依赖

```bash
cd workers
npm install
```

### 2. 登录 Cloudflare

```bash
npx wrangler login
```

### 3. 部署 Worker

```bash
npm run deploy
```

部署后会得到一个 URL，例如：`https://aave-browser-rendering.your-subdomain.workers.dev`

### 4. 配置环境变量

在项目根目录的 `.env` 文件中添加：

```bash
CLOUDFLARE_WORKER_URL=https://aave-browser-rendering.your-subdomain.workers.dev
```

## API 使用

### 提取 Campaign Info

```bash
curl -X POST https://your-worker-url.workers.dev \
  -H "Content-Type: application/json" \
  -d '{
    "action": "extractCampaignInfo",
    "key": "celo-supply-usdt"
  }'
```

### 提取 Self Authentication 描述

```bash
curl -X POST https://your-worker-url.workers.dev \
  -H "Content-Type: application/json" \
  -d '{
    "action": "extractSelfAuth",
    "key": "celo-supply-usdt"
  }'
```

## 响应格式

成功：
```json
{
  "success": true,
  "result": [...]
}
```

失败：
```json
{
  "success": false,
  "error": "Error message"
}
```
