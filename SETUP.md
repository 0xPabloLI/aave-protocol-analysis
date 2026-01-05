# Aave APY Dashboard - 设置指南

## 快速开始

### 1. 安装后端依赖

```bash
cd backend
npm install
```

### 2. 安装前端依赖

```bash
cd frontend
npm install
```

### 3. 首次运行数据获取（可选）

如果需要生成数据文件，运行主项目的数据获取脚本：

```bash
# 在项目根目录
npm run dev
```

这会在 `data/aave-formatted-data.json` 生成数据文件。

### 4. 启动后端服务器

```bash
cd backend
npm run dev
```

后端将在 `http://localhost:3001` 启动

### 5. 启动前端开发服务器

在新的终端窗口：

```bash
cd frontend
npm run dev
```

前端将在 `http://localhost:5173` 启动

## 功能说明

### 后端 API

- **GET /api/markets** - 获取市场数据（支持排序和筛选）
- **GET /api/markets/stats** - 获取统计信息
- **GET /api/markets/chains** - 获取链列表
- **POST /api/markets/refresh** - 手动刷新数据

### 前端功能

- 📊 统一表格展示所有市场数据
- 🔄 列头双向箭头排序（点击列头切换升序/降序）
- 🔍 按链筛选（多选按钮）
- 🔎 代币搜索
- 🔁 APY/APR 切换（切换按钮）
- ⚡ 实时数据更新（1分钟时效）
- 🎨 现代化的 UI 设计（Tailwind CSS）

### 数据更新

后端使用定时任务每 1 分钟自动更新数据。数据从 `data/aave-formatted-data.json` 读取。

## 环境变量

前端可以配置 API URL（可选）：

在 `frontend/.env` 中：
```
VITE_API_URL=http://localhost:3001/api
```

## 注意事项

- 确保数据文件 `data/aave-formatted-data.json` 存在
- 后端需要访问父目录的 `data/` 文件夹
- 前端需要后端 API 运行在 `http://localhost:3001`

