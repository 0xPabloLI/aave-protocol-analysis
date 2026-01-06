# 云服务部署指南

本文档介绍如何将后端服务部署到各种云服务平台。

## 推荐云服务商

### 1. Railway（推荐，最简单）
- ✅ 免费额度充足
- ✅ 自动部署
- ✅ 支持 Docker
- ✅ 自动 HTTPS
- 官网：https://railway.app

### 2. Render
- ✅ 免费套餐
- ✅ 自动部署
- ✅ 支持 Docker
- ✅ 自动 HTTPS
- 官网：https://render.com

### 3. Fly.io
- ✅ 免费额度
- ✅ 全球边缘部署
- ✅ 支持 Docker
- 官网：https://fly.io

### 4. DigitalOcean App Platform
- 💰 付费但价格合理
- ✅ 简单易用
- ✅ 自动 HTTPS
- 官网：https://www.digitalocean.com/products/app-platform

## 部署方式

### 方式 1: Railway 部署（推荐）

#### 步骤 1: 准备项目
确保项目已推送到 GitHub/GitLab/Bitbucket

#### 步骤 2: 连接 Railway
1. 访问 https://railway.app
2. 使用 GitHub 账号登录
3. 点击 "New Project"
4. 选择 "Deploy from GitHub repo"
5. 选择你的仓库

#### 步骤 3: 配置环境变量
在 Railway 项目设置中添加：
```
PORT=3001
NODE_ENV=production
```

#### 步骤 4: 设置启动命令
Railway 会自动检测 Dockerfile，如果没有，可以设置：
- Build Command: `npm install && npm run build && cd backend && npm install && npm run build`
- Start Command: `cd backend && node dist/server.js`

#### 步骤 5: 部署
Railway 会自动构建和部署，完成后会提供 URL

---

### 方式 2: Render 部署

#### 步骤 1: 准备项目
确保项目已推送到 GitHub

#### 步骤 2: 创建 Web Service
1. 访问 https://render.com
2. 使用 GitHub 账号登录
3. 点击 "New +" → "Web Service"
4. 连接你的 GitHub 仓库

#### 步骤 3: 配置服务
- **Name**: aave-backend
- **Environment**: Node
- **Build Command**: 
  ```bash
  npm install && npm run build && cd backend && npm install && npm run build
  ```
- **Start Command**: 
  ```bash
  cd backend && node dist/server.js
  ```
- **Environment Variables**:
  ```
  PORT=3001
  NODE_ENV=production
  ```

#### 步骤 4: 部署
点击 "Create Web Service"，Render 会自动部署

---

### 方式 3: Fly.io 部署

#### 步骤 1: 安装 Fly CLI
```bash
curl -L https://fly.io/install.sh | sh
```

#### 步骤 2: 登录
```bash
fly auth login
```

#### 步骤 3: 初始化项目
```bash
fly launch
```

#### 步骤 4: 部署
```bash
fly deploy
```

---

### 方式 4: 使用 Docker 部署到任意云服务器

#### 步骤 1: 准备服务器
确保服务器已安装 Docker 和 Docker Compose

#### 步骤 2: 上传项目
```bash
# 使用 git clone 或 scp 上传项目
git clone <your-repo-url>
cd aave
```

#### 步骤 3: 构建和运行
```bash
docker-compose up -d --build
```

#### 步骤 4: 配置防火墙
```bash
# 开放 3001 端口（根据你的云服务商调整）
# AWS: 在安全组中开放 3001
# 阿里云: 在安全组中开放 3001
# 腾讯云: 在安全组中开放 3001
```

---

## 环境变量配置

所有云平台都需要设置以下环境变量：

```bash
PORT=3001
NODE_ENV=production
```

某些平台（如 Railway）会自动设置 PORT，你只需要设置 `NODE_ENV=production`

---

## 数据持久化

### 重要提示
后端服务需要 `data/` 目录来存储数据文件。在云部署时：

1. **Railway**: 使用 Volume 挂载持久化存储
2. **Render**: 使用 Disk 存储
3. **Fly.io**: 使用 Volume
4. **Docker**: 使用 Volume 挂载

### 配置示例（docker-compose.yml）
```yaml
volumes:
  - ./data:/app/data
  - ./backend/logs:/app/backend/logs
```

---

## 健康检查

部署后，可以通过以下端点检查服务状态：

```
GET https://your-domain.com/health
```

应该返回：
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

---

## 常见问题

### 1. 端口配置
大多数云平台会自动设置 PORT 环境变量，确保代码使用 `process.env.PORT || 3001`

### 2. 数据文件路径
确保数据文件路径使用相对路径，如 `../data/aave-formatted-data.json`

### 3. 首次启动
首次启动时，数据文件可能不存在，服务会尝试获取数据。如果失败，服务仍会启动但数据为空。

### 4. 定时任务
定时任务会在服务启动后自动运行，每 1 分钟更新一次数据。

---

## 获取部署 URL

部署完成后，云平台会提供：
- **Railway**: `https://your-app-name.up.railway.app`
- **Render**: `https://your-app-name.onrender.com`
- **Fly.io**: `https://your-app-name.fly.dev`

你可以使用这个 URL 访问 API：
```
https://your-domain.com/api/markets
https://your-domain.com/health
```

---

## 监控和日志

### Railway
- 在 Dashboard 中查看日志
- 支持实时日志流

### Render
- 在 Dashboard 的 "Logs" 标签页查看
- 支持日志搜索

### Fly.io
```bash
fly logs
```

---

## 更新部署

当你推送代码到 Git 仓库时，大多数云平台会自动重新部署。你也可以手动触发：

- **Railway**: 在 Dashboard 点击 "Redeploy"
- **Render**: 在 Dashboard 点击 "Manual Deploy"
- **Fly.io**: `fly deploy`

