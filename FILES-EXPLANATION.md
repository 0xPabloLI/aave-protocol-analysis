# 文件功能说明

本文档详细说明项目中每个文件的功能和作用。

## 后端文件（backend/）

### 配置文件

#### `backend/package.json`
- **功能**：后端项目的依赖管理文件
- **作用**：定义了后端所需的依赖包（express, cors, node-cron, typescript 等）和脚本命令（build, start, dev）
- **关键依赖**：
  - `express`：Web 框架
  - `cors`：跨域支持
  - `node-cron`：定时任务

#### `backend/tsconfig.json`
- **功能**：TypeScript 编译器配置
- **作用**：定义了 TypeScript 编译选项（目标版本、模块系统、输出目录等）

---

### 核心服务文件

#### `backend/src/server.ts`
- **功能**：Express 服务器入口文件
- **作用**：
  - 创建 Express 应用实例
  - 配置 CORS 中间件
  - 注册路由（`/api/markets`）
  - 启动时加载数据到内存缓存
  - 启动定时更新任务（每1分钟）
  - 启动 HTTP 服务器（默认端口 3001）
- **关键流程**：
  1. 启动时调用 `dataService.loadData()` 加载数据
  2. 调用 `startUpdateScheduler()` 启动定时任务
  3. 监听端口，提供 API 服务

#### `backend/src/services/dataService.ts`
- **功能**：数据服务层 - 内存缓存 + 文件读取
- **作用**：
  - 管理内存缓存（避免频繁文件 I/O）
  - 从 `../data/aave-formatted-data.json` 读取数据
  - 计算 `apySpread` 字段（totalSupplyApy - totalBorrowApy）
  - 检查数据是否过期（超过1分钟未更新）
  - 提供数据加载、获取、刷新接口
- **核心方法**：
  - `loadData()`：从文件加载数据到内存缓存
  - `getData()`：获取缓存数据（如果为空则先加载）
  - `refreshCache()`：刷新缓存（重新从文件加载）
  - `getLastUpdated()`：获取最后更新时间
  - `isStale()`：检查数据是否过期

#### `backend/src/services/fetchService.ts`
- **功能**：数据获取服务 - 复用主项目的数据获取逻辑
- **作用**：
  - 通过执行主项目的 `npm run dev` 脚本来获取最新数据
  - 复用 `src/index.ts` 中的 `fetchAaveMarkets()` 函数逻辑
  - 更新 `data/aave-formatted-data.json` 文件
- **实现方式**：使用 `spawn` 执行主项目的脚本（子进程）
- **调用场景**：定时任务或手动刷新时调用

#### `backend/src/services/updateScheduler.ts`
- **功能**：定时更新任务调度器
- **作用**：
  - 使用 `node-cron` 创建定时任务
  - **每 1 分钟**自动执行一次数据更新
  - 如果上一次更新还在进行中，跳过本次更新（避免并发）
  - 调用 `fetchService.ts` 获取最新数据
  - 更新成功后刷新 `dataService` 的缓存
  - 更新状态管理（idle/updating/error）
- **关键逻辑**：
  - 检查更新状态，如果正在更新则跳过
  - 异步执行更新，不阻塞主线程
  - 错误处理：更新失败时记录错误，但不中断服务

---

### 路由和控制器

#### `backend/src/routes/markets.ts`
- **功能**：市场数据路由定义
- **作用**：
  - 定义所有市场相关的 API 路由
  - 将 HTTP 请求映射到对应的控制器方法
- **路由列表**：
  - `GET /` → `getMarkets`（获取市场数据）
  - `GET /stats` → `getStats`（获取统计信息）
  - `POST /refresh` → `refreshMarkets`（手动刷新数据）
  - `GET /chains` → `getChains`（获取链列表）

#### `backend/src/controllers/marketsController.ts`
- **功能**：市场数据控制器 - 业务逻辑处理
- **作用**：
  - 处理所有市场相关的 HTTP 请求
  - 实现排序和筛选逻辑
  - 管理更新状态
- **核心函数**：

  1. **`getMarkets()`** - GET /api/markets
     - 从 `dataService` 获取数据
     - 根据查询参数进行排序和筛选
     - 支持排序字段：totalSupplyApy, totalBorrowApy, apySpread, supplyApy, borrowApy
     - 支持筛选：chain（链名）、token（代币搜索）、minSupplyApy、maxBorrowApy
     - 返回数据 + lastUpdated + isStale + updateInProgress

  2. **`getStats()`** - GET /api/markets/stats
     - 统计总市场数、链数、代币数
     - 返回链列表

  3. **`getChains()`** - GET /api/markets/chains
     - 获取所有链名称列表（去重）

  4. **`refreshMarkets()`** - POST /api/markets/refresh
     - 手动触发数据更新
     - 如果正在更新中，返回状态
     - 否则异步触发更新任务，立即返回

  5. **`sortAndFilterData()`** - 内部辅助函数
     - 实现数据排序和筛选逻辑
     - 处理 null 值（null 值排在最后）
     - 支持多链筛选（逗号分隔）

- **状态管理**：
  - `updateStatus`：更新状态（idle/updating/error）
  - `getUpdateStatus()`：获取当前状态
  - `setUpdateStatus()`：设置状态

---

### 中间件和类型定义

#### `backend/src/middleware/cors.ts`
- **功能**：CORS（跨域资源共享）中间件配置
- **作用**：
  - 允许前端应用（默认 http://localhost:5173）访问后端 API
  - 配置允许的 HTTP 方法（GET, POST, OPTIONS）
  - 配置允许的请求头
  - 支持 credentials（用于携带 Cookie 等认证信息）

#### `backend/src/types/index.ts`
- **功能**：TypeScript 类型定义
- **作用**：
  - 定义后端使用的所有接口和类型
  - 复用主项目的 `FormattedReserveData` 结构
- **核心类型**：
  - `MarketWithSpread`：扩展了 `FormattedReserveData`，添加 `apySpread` 字段
  - `MarketsResponse`：API 响应格式（包含 data, lastUpdated, isStale, updateInProgress）
  - `UpdateStatus`：更新状态类型（idle/updating/error）

---

## 前端文件（frontend/）

### 配置文件

#### `frontend/package.json`
- **功能**：前端项目的依赖管理文件
- **作用**：定义前端所需的依赖包（react, vite, axios, tailwindcss 等）

#### `frontend/tsconfig.json`, `frontend/tsconfig.app.json`, `frontend/tsconfig.node.json`
- **功能**：TypeScript 配置（主配置、应用配置、Node 配置）
- **作用**：定义前端 TypeScript 编译选项

#### `frontend/vite.config.ts`
- **功能**：Vite 构建工具配置
- **作用**：配置开发服务器、构建选项、插件等

#### `frontend/tailwind.config.js`
- **功能**：Tailwind CSS 配置
- **作用**：配置 Tailwind CSS 的扫描路径、主题等

#### `frontend/.env`
- **功能**：环境变量配置
- **作用**：定义后端 API URL（`VITE_API_URL=http://localhost:3001/api`）

---

### 核心应用文件

#### `frontend/src/main.tsx`
- **功能**：React 应用入口文件
- **作用**：
  - 创建 React 根节点
  - 渲染 `App` 组件
  - 启用严格模式

#### `frontend/src/App.tsx`
- **功能**：主应用组件
- **作用**：
  - 应用的最外层容器
  - 渲染 `MarketsTable` 组件
  - 应用全局样式

#### `frontend/src/index.css`
- **功能**：全局样式文件
- **作用**：
  - 导入 Tailwind CSS（@tailwind base/components/utilities）
  - 定义全局样式（字体、字体平滑等）

---

### 服务和类型定义

#### `frontend/src/services/api.ts`
- **功能**：API 客户端封装
- **作用**：
  - 使用 `axios` 封装所有后端 API 调用
  - 统一管理 API 基础 URL
  - 提供类型安全的 API 方法
- **核心方法**：
  - `getMarkets(params)`：获取市场数据（支持排序和筛选参数）
  - `getStats()`：获取统计信息
  - `getChains()`：获取链列表
  - `refreshMarkets()`：手动刷新数据

#### `frontend/src/types/index.ts`
- **功能**：TypeScript 类型定义
- **作用**：
  - 定义前端使用的所有接口和类型
  - 与后端类型保持一致
- **核心类型**：
  - `MarketWithSpread`：市场数据项（包含 apySpread）
  - `MarketsResponse`：API 响应格式
  - `MarketsStats`：统计信息
  - `SortField`：排序字段类型
  - `SortOrder`：排序方向类型
  - `FilterOptions`：筛选选项类型

---

### Hooks

#### `frontend/src/hooks/useMarkets.ts`
- **功能**：市场数据获取的 React Hook
- **作用**：
  - 封装数据获取逻辑
  - 管理加载状态、错误状态
  - 根据排序和筛选参数自动重新获取数据
  - 返回数据、加载状态、错误、最后更新时间、是否过期等信息
- **核心逻辑**：
  - 使用 `useEffect` 监听排序和筛选参数变化
  - 参数变化时自动重新请求数据
  - 使用 `cancelled` 标志防止竞态条件

---

### 组件

#### `frontend/src/components/MarketsTable.tsx`
- **功能**：市场数据表格组件（核心组件）
- **作用**：
  - 展示所有市场数据的表格
  - 实现列头双向箭头排序功能
  - 集成筛选控件
  - 实现 APY/APR 切换功能（UI 已实现）
  - 显示数据最后更新时间和过期状态
  - 高亮显示负数 APY Spread（looping 机会）
- **核心功能**：
  1. **排序功能**：
     - `handleSort(field)`：处理列头点击，切换排序状态
     - 排序状态循环：无排序 → 升序 → 降序 → 无排序
     - `getSortIcon(field)`：获取排序图标（⇅ ↑ ↓）
     - `getSortClass(field)`：获取排序样式类（蓝色高亮）

  2. **数据展示**：
     - 使用 `useMarkets` hook 获取数据
     - 表格展示：Token、Chain、Supply APY、Borrow APY、Total Supply APY、Total Borrow APY、APY Spread
     - 负数 APY Spread 用橙色高亮显示

  3. **APY/APR 切换**：
     - 切换按钮 UI（Toggle）
     - 当前仅 UI 实现，实际计算逻辑待完善

  4. **加载和错误处理**：
     - 显示加载状态（LoadingSpinner）
     - 显示错误信息
     - 显示数据过期警告

#### `frontend/src/components/FilterControls.tsx`
- **功能**：筛选控件组件
- **作用**：
  - 实现按链筛选（多选按钮）
  - 实现代币搜索（输入框）
  - 实时更新筛选参数，触发数据重新获取
- **核心功能**：
  - `handleChainToggle(chain)`：切换链的选中状态
  - `handleTokenSearch(value)`：处理代币搜索输入
  - 从 API 获取可用链列表
  - 多选按钮样式（选中：蓝色，未选中：白色边框）

#### `frontend/src/components/LoadingSpinner.tsx`
- **功能**：加载指示器组件
- **作用**：
  - 显示数据加载中的动画效果
  - 使用 Tailwind CSS 的动画类（animate-spin）
  - 简单的旋转圆环动画

---

## 文档文件

#### `PLAN-REQUIREMENTS.md`
- **功能**：需求与架构文档
- **作用**：详细说明项目的需求、架构设计、实现细节，供其他 agent 参考

#### `SETUP.md`
- **功能**：设置指南
- **作用**：快速开始指南，说明如何安装依赖、启动前后端服务

#### `README-BACKEND.md`
- **功能**：后端 README
- **作用**：后端 API 的使用说明和 API 端点文档

#### `README-FRONTEND.md`
- **功能**：前端 README
- **作用**：前端功能特性说明和使用指南

---

## 文件关系图

### 后端数据流

\`\`\`
server.ts (启动)
  ├── dataService.loadData() → 加载数据到内存
  ├── startUpdateScheduler() → 启动定时任务
  │     └── updateScheduler.ts
  │           └── fetchService.ts → 执行主项目脚本更新数据
  │                 └── 更新 data/aave-formatted-data.json
  │                       └── dataService.refreshCache() → 刷新内存缓存
  │
  └── routes/markets.ts (路由)
        └── controllers/marketsController.ts
              ├── getMarkets() → dataService.getData() → 返回数据
              ├── getStats() → dataService.getData() → 统计
              ├── getChains() → dataService.getData() → 链列表
              └── refreshMarkets() → fetchService.fetchMarketData() → 手动刷新
\`\`\`

### 前端数据流

\`\`\`
main.tsx (入口)
  └── App.tsx
        └── MarketsTable.tsx
              ├── useMarkets() hook
              │     └── api.ts → GET /api/markets
              │           └── 后端 API
              │
              ├── FilterControls.tsx
              │     └── api.ts → GET /api/markets/chains
              │           └── 获取链列表
              │
              └── 表格展示
                    └── 列头排序 → 更新 useMarkets 参数 → 重新获取数据
\`\`\`

---

## 关键设计决策

### 1. 为什么使用 JSON 文件 + 内存缓存？
- 数据量小（~229 条记录）
- 读取速度快（内存缓存 < 1ms）
- 无需数据库维护（简化部署）
- 数据结构简单（主要是排序和筛选）

### 2. 为什么每 1 分钟更新一次？
- 满足数据时效要求（不超过 1 分钟）
- 避免外部 API 限流（1 分钟间隔足够分散请求）
- 如果更新还在进行中，跳过本次（避免并发）

### 3. 为什么使用列头双向箭头而不是大按钮？
- 更简洁的 UI 设计
- 用户可以直接在表格上操作
- 符合常见的表格交互习惯

### 4. 为什么复用主项目的 fetchAaveMarkets？
- 避免代码重复
- 保持数据获取逻辑的一致性
- 维护更方便（只需要维护一套逻辑）

### 5. 为什么使用 @aave/client 而不是 @aave/react？
- 当前只需要数据展示，不需要链上交互
- @aave/client 是后端 Node.js SDK，适合服务端数据获取
- @aave/react 是前端 React hooks，用于浏览器中的链上交互（连接钱包、提交交易）
- 未来如果需要前端交互功能，再考虑引入 @aave/react
