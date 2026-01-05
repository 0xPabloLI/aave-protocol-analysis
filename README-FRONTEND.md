# Frontend Dashboard

## 安装依赖

```bash
cd frontend
npm install
```

## 开发模式运行

```bash
npm run dev
```

前端将在 `http://localhost:5173` 启动

## 构建

```bash
npm run build
```

构建产物在 `dist/` 目录

## 环境变量

创建 `.env` 文件：

```
VITE_API_URL=http://localhost:3001/api
```

## 功能特性

- 📊 统一表格展示所有市场数据
- 🔄 列头双向箭头排序（点击列头切换升序/降序）
- 🔍 按链筛选（多选）
- 🔎 代币搜索
- 🔁 APY/APR 切换
- ⚡ 实时数据更新（1分钟时效）
- 🎨 现代化的 UI 设计（Tailwind CSS）

