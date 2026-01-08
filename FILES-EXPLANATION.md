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

## 数据获取服务文件（src/）

### 核心文件

#### `src/index.ts`
- **功能**：数据获取服务主入口
- **作用**：
  - 集成所有数据源（Aave SDK, Merit API, Merkl API, Brevis API）
  - 获取市场数据并格式化
  - 保存数据到 JSON 和 CSV 文件
  - 输出详细的市场分布信息

#### `src/logger.ts`
- **功能**：日志配置模块
- **作用**：使用 winston 配置日志输出（控制台和文件）

#### `src/merit-api.ts`
- **功能**：Merit Protocol API 客户端
- **作用**：获取 Merit APR 激励数据

#### `src/merkl-api.ts`
- **功能**：Merkl API 客户端
- **作用**：获取 Merkl 激励活动数据

#### `src/brevis-api.ts`
- **功能**：Brevis Network API 客户端
- **作用**：获取 Brevis Network Linea Surge APR 数据

---

## 根目录配置文件

#### `package.json`
- **功能**：根目录依赖管理文件
- **作用**：定义数据获取服务所需的依赖包和脚本命令
- **关键依赖**：
  - `@aave/client`：Aave SDK
  - `@bgd-labs/aave-address-book`：Aave 地址簿
  - `winston`：日志管理
  - `node-fetch`：HTTP 请求

#### `tsconfig.json`
- **功能**：TypeScript 编译器配置
- **作用**：定义 TypeScript 编译选项（目标版本、模块系统、输出目录等）

---

## 文档文件

#### `README.md`
- **功能**：项目主文档
- **作用**：项目概述、快速开始、功能说明等

#### `README-BACKEND.md`
- **功能**：后端 README
- **作用**：后端 API 的使用说明和 API 端点文档

#### `SETUP.md`
- **功能**：设置指南
- **作用**：快速开始指南，说明如何安装依赖、启动服务

---

## 文件关系图

### 数据流

\`\`\`
src/index.ts (数据获取)
  ├── fetchAaveMarkets() → Aave SDK
  ├── fetchMeritData() → Merit API
  ├── fetchMerklData() → Merkl API
  └── fetchBrevisData() → Brevis API
        └── 保存到 data/aave-formatted-data.json

backend/src/server.ts (API 服务器)
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

### 3. 为什么复用主项目的 fetchAaveMarkets？
- 避免代码重复
- 保持数据获取逻辑的一致性
- 维护更方便（只需要维护一套逻辑）

### 4. 为什么使用 @aave/client？
- @aave/client 是后端 Node.js SDK，适合服务端数据获取
- 提供完整的市场数据访问接口
- 支持多链数据获取
