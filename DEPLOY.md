# 后端部署指南

本文档面向开发者，介绍如何部署 Aave Backend 服务到生产环境或本地测试环境。

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

**重要：统一在仓库根目录 `.env` 文件中配置环境变量（只维护这一份）。**

可以通过环境变量配置服务：

- `PORT`: 服务器端口（默认: 3001）
- `NODE_ENV`: 运行环境（production/development）

示例：

```bash
# 在仓库根目录 .env 文件中设置
PORT=3001
NODE_ENV=production
```

将需要的变量写入仓库根目录 `.env`（并确保不要提交到 Git）。

## 数据更新

后端服务会自动每 1 分钟更新一次数据。所有 API 端点都会自动检查数据新鲜度，如果数据过期（>1分钟），会自动触发更新。

## 健康检查

检查服务是否正常运行：

```bash
curl http://localhost:3001/health
```

应该返回：

```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## API 端点

- `GET /health` - 健康检查
- `GET /api/markets` - 获取市场数据（自动检查数据新鲜度）
- `GET /api/markets/list` - 获取市场列表（自动检查数据新鲜度）
- `GET /api/campaigns/forecast-states` - 批量获取 Merkl forecast states（不传 ids 时返回全部）

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
   ls -la data/aave-formatted-data.json
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
