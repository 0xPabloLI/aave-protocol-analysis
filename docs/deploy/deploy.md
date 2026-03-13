# 后端部署指南

本文档面向开发者，介绍如何部署 Aave Backend 服务到生产环境或本地测试环境。

## 部署架构选择

| 架构 | 适用场景 | 说明 |
|------|----------|------|
| **单服务**（本文档） | 自建服务器、Railway 常驻模式 | 简单直接，一个进程包含 API + 定时任务 |
| **三服务**（[详见此文档](./railway-three-service-architecture.md)） | Railway Serverless / App Sleeping | API + 更新服务 + Redis 分离，支持 API 休眠 |

若计划在 Railway 使用 Serverless（App Sleeping）模式，推荐阅读 [三服务架构方案](./railway-three-service-architecture.md)。

## 前置要求

- Node.js 20+ 
- npm 或 yarn
- （可选）PM2 - 用于进程管理

## 快速开始（本地测试）

对于本地测试，可以直接使用 npm 命令，无需部署脚本：

```bash
# 1. 安装依赖
npm install
cd backend && npm install && cd ..

# 2. 构建
npm run build
cd backend && npm run build && cd ..

# 3. 运行（需要先获取数据）
node dist/index.js  # 首次运行获取数据
cd backend && npm start  # 启动后端服务
```

## 部署方式

### 方式 1: 使用部署脚本（推荐生产环境）

部署脚本会自动处理依赖安装、代码构建和启动。

```bash
cd backend
chmod +x deploy.sh
./deploy.sh pm2    # 使用 PM2 部署（推荐生产环境）
```

### 方式 2: 手动部署

#### 2.1 使用 PM2（推荐生产环境）

```bash
# 1. 安装根目录依赖（数据获取脚本）
npm install

# 2. 构建根目录代码
npm run build

# 3. 首次运行数据获取（生成初始数据）
node dist/index.js

# 4. 安装后端依赖
cd backend
npm install

# 5. 构建后端代码
npm run build

# 6. 安装 PM2（如果未安装）
npm install -g pm2

# 7. 启动服务
cd ..
pm2 start ecosystem.config.cjs

# 查看状态
pm2 status

# 查看日志
pm2 logs aave-backend

# 停止服务
pm2 stop aave-backend

# 重启服务
pm2 restart aave-backend

# 设置开机自启
pm2 startup
pm2 save
```

#### 2.2 本地运行（开发测试）

```bash
# 1. 安装根目录依赖
npm install

# 2. 构建根目录代码
npm run build

# 3. 首次运行数据获取
node dist/index.js

# 4. 安装后端依赖
cd backend
npm install

# 5. 构建后端代码
npm run build

# 6. 启动服务器
npm start
```

## 环境变量

**重要：统一在仓库根目录 `.env` 文件中配置环境变量（只维护这一份）。** 生产环境可使用 Doppler（`DOPPLER_TOKEN`）或 Railway 等注入变量；优先级：系统环境变量 > `.env` > 默认值。

常用变量：

- `PORT` - 服务端口（默认 3001）
- `NODE_ENV` - 运行环境（development / production）
- `FRONTEND_URL` - 生产环境 CORS 白名单（逗号分隔）
- `ALLOWED_DEV_ORIGINS` - 开发环境 CORS 白名单（可选）
- `COINMARKETCAP_API_KEY` - FDV 优先使用 CoinMarketCap 时必填
- `COINGECKO_API_KEY` - CoinGecko 认证（可选，可提高配额）
- `DOPPLER_TOKEN` - 生产环境从 Doppler 拉取密钥时使用

Merkl 预测相关（可选，有默认值）：`MERKL_FORECAST_RESULT_CACHE_TTL_MS`、`MERKL_FORECAST_OPPORTUNITY_META_CACHE_TTL_MS`、`MERKL_METRICS_CACHE_TTL_MS`。详见 [AGENTS.md](../../AGENTS.md#configuration)。

## 数据更新

- **市场数据**：仅 `GET /api/markets` 会触发市场数据新鲜度检查；若数据超过 1 分钟未更新，该请求会触发自动刷新（带并发控制）。后端另有每分钟定时任务作为兜底。
- **其他端点**：`/api/coingecko-*`、`/api/campaigns/forecast-states`、`/api/rate-inputs` 使用各自缓存/TTL，不触发市场数据刷新。
- **FDV**：FDV 缓存由后端定时任务每 **5 分钟**预热一次，请求路径与 cron 共用同一 TTL（5 分钟），过期时请求也可触发刷新。

## 健康检查

检查服务是否正常运行：

```bash
curl http://localhost:3001/health
```

应该返回（示例）：

```json
{
  "status": "ok",
  "timestamp": "2026-03-11T12:00:00.000Z",
  "environment": {
    "nodeEnv": "development",
    "port": 3001,
    "corsMode": "allow-all",
    "frontendUrl": "not set",
    "allowedDevOrigins": "not set"
  }
}
```

## API 端点

共 7 个端点，完整说明见 [docs/api/api-documentation.md](../api/api-documentation.md)：

- `GET /health`、`GET /api/health` - 健康检查（含环境信息）
- `GET /api/markets` - 市场数据（`markets-v2`：`snapshot + reserves`；**仅此端点**会触发市场数据新鲜度检查与自动刷新）
- `GET /api/coingecko-categories` - CoinGecko 分类（稳定币、ETH 相关）
- `GET /api/coingecko-fdv` - FDV 数据（CoinMarketCap 优先，CoinGecko 回退）
- `GET /api/campaigns/forecast-states` - Merkl 活动预测状态（可选 `ids=...`）
- `GET /api/rate-inputs` - 储备利率输入（可选 `chainId`、`asset`、`marketName`）

## 日志

### 日志文件位置

- **数据获取脚本日志**：`logs/combined.log` 和 `logs/error.log`（根目录）
- **PM2 错误日志**：`backend/logs/pm2-error.log`
- **实时日志**：使用 `pm2 logs aave-backend` 查看所有实时日志

### 日志管理

- Winston 日志自动轮转：每个文件最大 5MB，保留 5 个文件
- PM2 日志轮转：通过 `pm2-logrotate` 模块管理（50MB，保留 2 个文件）

## 故障排查

### 服务无法启动

1. 检查端口是否被占用：
   ```bash
   lsof -i :3001
   ```

2. 检查数据文件是否存在：
   ```bash
   ls -la data/runtime/aave-formatted-data.json
   ```

3. 查看日志：
   ```bash
   pm2 logs aave-backend
   ```

### 数据更新失败

1. 检查网络连接
2. 查看应用日志中的错误信息
3. 手动运行数据获取脚本：
   ```bash
   node dist/index.js
   ```

### PM2 相关问题

```bash
# 查看所有进程
pm2 list

# 查看详细信息
pm2 describe aave-backend

# 清除日志
pm2 flush

# 删除进程
pm2 delete aave-backend
```

## 生产环境建议

1. **使用 PM2** 确保服务在后台运行
2. **设置开机自启**（PM2: `pm2 startup && pm2 save`）
3. **配置日志轮转** 避免日志文件过大
4. **监控服务状态** 使用 PM2 监控
5. **配置反向代理**（如 Nginx）用于负载均衡和 SSL
6. **设置防火墙规则** 只开放必要端口

## 更新部署

当代码更新后：

```bash
# 1. 拉取最新代码
git pull

# 2. 重新构建
npm run build
cd backend && npm run build && cd ..

# 3. 重启服务
pm2 restart aave-backend
```
