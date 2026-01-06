# 前端配置指南

本文档介绍如何配置前端以从服务器读取数据。

## 配置方法

### 方法 1: 使用环境变量文件（推荐）

在 `frontend/` 目录下创建 `.env` 文件：

```bash
cd frontend
```

创建 `.env` 文件：

```env
# 生产环境：使用服务器地址
VITE_API_URL=http://43.247.134.242:3001/api
```

或者创建 `.env.production` 文件（仅在生产构建时使用）：

```env
VITE_API_URL=http://43.247.134.242:3001/api
```

### 方法 2: 直接修改代码

编辑 `frontend/src/services/api.ts` 文件：

```typescript
// 将这行：
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

// 改为：
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://43.247.134.242:3001/api';
```

### 方法 3: 构建时指定环境变量

```bash
cd frontend
VITE_API_URL=http://43.247.134.242:3001/api npm run build
```

## 快速配置步骤

### 1. 创建环境变量文件

```bash
cd frontend
echo "VITE_API_URL=http://43.247.134.242:3001/api" > .env.production
```

### 2. 重新构建前端

```bash
npm run build
```

### 3. 测试配置

启动预览服务器：

```bash
npm run preview
```

访问 `http://localhost:4173` 查看是否正常加载数据。

## 环境变量说明

- **VITE_API_URL**: API 基础 URL
  - 开发环境默认: `http://localhost:3001/api`
  - 生产环境: `http://43.247.134.242:3001/api`

## 不同环境的配置

### 开发环境（本地开发）

创建 `frontend/.env.local`（不会被提交到 Git）：

```env
VITE_API_URL=http://localhost:3001/api
```

### 生产环境

创建 `frontend/.env.production`：

```env
VITE_API_URL=http://43.247.134.242:3001/api
```

## 验证配置

配置完成后，可以通过以下方式验证：

1. **检查环境变量是否生效**：
   - 在浏览器控制台查看网络请求
   - 请求应该发送到 `http://43.247.134.242:3001/api/markets`

2. **测试 API 连接**：
   ```bash
   curl http://43.247.134.242:3001/api/markets
   ```

3. **检查 CORS**：
   - 如果遇到 CORS 错误，后端已配置允许所有来源
   - 如果仍有问题，检查浏览器控制台的错误信息

## 常见问题

### 1. CORS 错误

如果遇到 CORS 错误，后端已配置允许跨域访问。如果仍有问题：

1. 检查后端服务是否运行：`curl http://43.247.134.242:3001/health`
2. 检查浏览器控制台的错误信息
3. 确保后端 CORS 配置正确（已更新为允许所有来源）

### 2. 网络请求失败

1. 检查服务器是否可访问：`ping 43.247.134.242`
2. 检查端口是否开放：`curl http://43.247.134.242:3001/health`
3. 检查防火墙配置

### 3. 环境变量不生效

1. 确保环境变量文件在 `frontend/` 目录下
2. 确保变量名以 `VITE_` 开头
3. 重新构建项目：`npm run build`
4. 重启开发服务器（如果使用 `npm run dev`）

## 部署前端

### 静态文件部署

构建完成后，`frontend/dist/` 目录包含所有静态文件，可以部署到：

- Nginx
- Apache
- Vercel
- Netlify
- GitHub Pages
- 任何静态文件托管服务

### Nginx 配置示例

```nginx
server {
    listen 80;
    server_name your-domain.com;
    root /path/to/frontend/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

## 更新配置

如果需要更改 API 地址：

1. 更新 `.env.production` 文件
2. 重新构建：`npm run build`
3. 重新部署前端文件

