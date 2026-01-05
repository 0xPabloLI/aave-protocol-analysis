# Aave APY Dashboard - 需求与架构文档

## 项目概述

本项目是一个 Aave 协议借贷 APY 数据展示仪表盘，帮助用户快速找到最优的借贷机会。主要功能包括：

- 显示所有 Aave 上 token 的借贷 APY
- 支持按 APY 自动排序，找到最值得 farming 的借贷对
- 支持 looping 机会识别（找到 borrow 成本低、supply 收益高的套利对）

## 核心需求

### 1. 数据展示需求

- **统一页面展示**：所有数据在同一个表格中展示，不按 network 分组
- **默认排序**：默认按 Total Supply APY 降序排列（找到最高收益的 lend 机会）
- **同一排序**：所有数据使用同一个排序规则，用户可以根据需要切换

### 2. 排序功能需求（三种核心场景）

#### 场景 1：找最高 APY 去 Lend
- **排序字段**：`totalSupplyApy`
- **排序方向**：降序（desc）
- **用途**：找到收益最高的 supply 机会

#### 场景 2：找最低 APY 去 Borrow
- **排序字段**：`totalBorrowApy`
- **排序方向**：升序（asc）
- **用途**：找到成本最低的 borrow 机会

#### 场景 3：找 Looping 机会
- **排序字段**：`apySpread`（差值 = totalSupplyApy - totalBorrowApy）
- **排序方向**：升序（asc，差值最小，包括负数）
- **用途**：找到可以套利的对（borrow 成本低，supply 收益高）
- **特殊标识**：负数差值用橙色/红色高亮显示
- **说明**：负数表示可以以低成本 borrow，然后用高收益 supply，形成套利

### 3. UI 交互需求

- **列头双向箭头排序**：
  - 每个可排序的列（Supply APY, Borrow APY, Total Supply APY, Total Borrow APY, APY Spread）显示小的双向箭头图标（⇅）
  - 点击列头切换状态：无排序 → 升序（↑）→ 降序（↓）→ 无排序
  - 视觉反馈：当前排序的列显示箭头方向（↑ 升序，↓ 降序），其他列显示双向箭头（⇅）
  - 排序的列用蓝色高亮显示

- **筛选功能**：
  - 按链筛选：下拉选择器，支持多选（如只显示 Arbitrum 和 Ethereum）
  - 按代币符号搜索：实时搜索框，模糊匹配 token symbol 或 name
  - APY 阈值筛选（可选功能，后续实现）

- **APY/APR 切换功能**：
  - 在表格顶部添加一个切换开关（Toggle），标签为 "APY / APR"
  - APY 模式（默认）：显示所有激励数据的 APY 值
  - APR 模式：显示所有激励数据的原始 APR 值
  - 影响范围：
    - Merit APR 字段（meritSupplyApr, meritBorrowApr 等）
    - Merkl APR 字段（merklSupplyApr, merklBorrowApr 等）
    - Brevis APR 字段（brevisSupplyApr, brevisBorrowApr）
    - Total Incentive APY/APR
    - Total Supply/Borrow APY/APR

### 4. 数据时效需求

- **数据时效要求**：数据时效不超过 1 分钟
- **更新策略**：
  - 后台定时任务每 1 分钟自动更新一次
  - 如果上一次更新还在进行中，跳过本次更新
  - 手动刷新端点（可选，不受最小间隔限制）
- **避免限流策略**：
  - 请求去重（如果更新正在进行中，新的更新请求会被跳过）
  - 并发控制（优化 API 调用顺序）
  - 错误降级（单个 API 失败不影响其他数据源）
  - 1 分钟间隔通常足够分散请求

### 5. 数据源需求

- **主要数据源**：`data/aave-formatted-data.json`
- **数据获取逻辑**：复用现有的 `src/index.ts` 中的 `fetchAaveMarkets()` 函数
- **数据字段**：使用现有的 `FormattedReserveData` 接口定义

## 技术架构

### 后端架构（Express + TypeScript）

#### 目录结构

```
backend/
├── src/
│   ├── server.ts                  # Express 服务器入口
│   ├── routes/
│   │   └── markets.ts            # 市场数据路由
│   ├── controllers/
│   │   └── marketsController.ts  # 业务逻辑
│   ├── services/
│   │   ├── dataService.ts        # 数据读取服务（内存缓存 + 文件读取）
│   │   ├── fetchService.ts       # 数据获取服务（复用 src/index.ts）
│   │   └── updateScheduler.ts    # 定时更新任务
│   ├── types/
│   │   └── index.ts              # 类型定义（复用 FormattedReserveData）
│   └── middleware/
│       └── cors.ts               # CORS 配置
├── package.json
└── tsconfig.json
```

#### API 端点设计

1. **GET /api/markets**
   - 获取所有市场数据（从 `data/aave-formatted-data.json` 读取）
   - 查询参数：
     - `sort`: 排序字段（`totalSupplyApy`, `totalBorrowApy`, `apySpread`, `supplyApy`, `borrowApy`）
     - `order`: 排序方向（`asc` | `desc`）
     - `chain`: 按链名筛选（多个用逗号分隔，如 "Arbitrum,Ethereum"）
     - `token`: 按代币符号搜索（模糊匹配）
     - `minSupplyApy`: 最小 Supply APY 阈值
     - `maxBorrowApy`: 最大 Borrow APY 阈值
   - 响应格式：
     ```typescript
     {
       data: MarketWithSpread[],
       lastUpdated: string,        // ISO 时间戳
       isStale: boolean,           // 如果超过1分钟未更新则为true
       updateInProgress: boolean   // 是否正在更新中
     }
     ```

2. **GET /api/markets/stats**
   - 获取统计信息（总代币数、链数等）
   - 响应：统计对象

3. **GET /api/markets/chains**
   - 获取所有链列表
   - 响应：链名称数组

4. **POST /api/markets/refresh**
   - 手动触发数据刷新
   - 如果正在更新中，返回更新状态
   - 如果空闲，立即触发更新（不等待定时任务）

#### 数据存储方案

**推荐：JSON 文件 + 内存缓存**

- ✅ 数据量小（~229 条记录，JSON 文件 < 5MB）
- ✅ 读取速度快（内存缓存 < 1ms，文件读取 < 10ms）
- ✅ 无需数据库维护（简化部署）
- ✅ 数据结构简单（主要是排序和筛选，无需复杂查询）
- ✅ 前端并发友好

**实现要点**：
- 内存缓存：后端启动时加载 JSON 到内存
- 文件缓存：定时任务更新 JSON 文件
- 缓存有效性检查：API 响应中包含 `lastUpdated` 和 `isStale` 标志
- 计算 apySpread：`apySpread = totalSupplyApy - totalBorrowApy`

#### 数据更新策略

1. **后台定时任务**：
   - 使用 `node-cron`
   - 每 1 分钟自动更新一次
   - 如果上一次更新还在进行中，跳过本次更新

2. **内存缓存 + 文件缓存**：
   - 内存缓存：后端启动时加载 JSON 到内存
   - 文件缓存：定时任务更新 JSON 文件
   - 缓存有效性检查：API 响应中包含 `lastUpdated` 和 `isStale` 标志

3. **API 调用优化**：
   - Aave SDK：按链并发请求（已有优化）
   - Merkl API：批量并发请求 campaign details（已有优化）
   - Merit API：单个请求
   - Brevis API：单个请求

4. **错误处理和降级**：
   - 如果某个 API 返回限流错误（429），跳过该数据源，使用上次缓存
   - 记录错误日志，但不中断整个更新流程
   - 使用指数退避策略重试失败的 API

5. **更新状态管理**：
   - 维护更新状态：`idle | updating | error`
   - 记录上次更新时间和上次成功时间

### 前端架构（React + TypeScript + Vite）

#### 目录结构

```
frontend/
├── src/
│   ├── App.tsx              # 主应用组件
│   ├── main.tsx             # 入口文件
│   ├── components/
│   │   ├── MarketsTable.tsx      # 市场数据表格
│   │   ├── FilterControls.tsx    # 筛选控制
│   │   └── LoadingSpinner.tsx    # 加载状态
│   ├── hooks/
│   │   └── useMarkets.ts         # 市场数据 hook
│   ├── services/
│   │   └── api.ts                # API 客户端
│   ├── types/
│   │   └── index.ts              # 类型定义
│   └── styles/
│       └── index.css             # 全局样式（Tailwind CSS）
├── package.json
├── tsconfig.json
└── vite.config.ts
```

#### UI 设计要点

- **样式库**：Tailwind CSS
- **表格设计**：现代化的表格布局，参考 app.aave.com 的设计风格
- **颜色编码**：
  - 高 Total Supply APY：绿色渐变
  - 低 Total Borrow APY：蓝色渐变
  - 负数 APY Spread（looping 机会）：橙色/红色高亮
- **响应式设计**：移动端友好
- **加载状态**：骨架屏或加载指示器
- **错误处理**：友好的错误提示

#### 核心组件功能

1. **MarketsTable 组件**：
   - 统一表格展示所有市场数据
   - 列头双向箭头排序
   - APY/APR 切换按钮
   - 数据刷新状态显示

2. **FilterControls 组件**：
   - 按链筛选（多选按钮）
   - 代币搜索框
   - APY 阈值筛选（可选）

3. **useMarkets Hook**：
   - 数据获取和状态管理
   - 排序和筛选参数处理
   - 自动刷新逻辑

## 数据流

### 正常请求流程

```
用户操作 → React 组件 → GET /api/markets → Express 后端
                                    ↓
                          检查内存缓存（如果为空则从文件加载）
                                    ↓
                          直接从内存缓存返回数据（不触发更新）
                                    ↓
                          计算 apySpread，应用排序和筛选
                                    ↓
                          返回 JSON 数组（包含原始 APR 数据 + lastUpdated + isStale + updateInProgress）
                                    ↓
                            React 组件更新
                          根据 APY/APR 切换模式显示
                          如果 isStale → 显示警告提示
```

### 数据更新流程（后台定时任务）

```
定时任务触发（每 1 分钟）→ 检查是否正在更新
                                    ↓
                            如果正在更新 → 跳过本次，等待下次
                                    ↓
                            如果空闲 → 检查文件锁
                                    ↓
                            如果无锁 → 获取锁 → 设置状态为"更新中"
                                    ↓
                            调用 fetchService.ts（复用 src/index.ts 逻辑）
                                    ↓
                            并发获取所有数据源（Aave/Merit/Merkl/Brevis）
                                    ↓
                            如果某个 API 失败 → 使用上次缓存，记录警告
                                    ↓
                            更新 data/aave-formatted-data.json
                                    ↓
                            释放文件锁 → 更新内存缓存
                                    ↓
                            设置状态为"空闲" → 记录更新时间戳
```

### 手动刷新流程

```
用户点击刷新 → POST /api/markets/refresh → 检查是否正在更新
                                    ↓
                            如果正在更新 → 返回更新状态（不重复触发）
                                    ↓
                            如果空闲 → 异步触发更新任务
                                    ↓
                            立即返回（不等待完成）
                                    ↓
                            前端轮询更新状态或等待完成
```

## 关键实现细节

### 后端计算 APY Spread

在 `marketsController.ts` 中，读取 JSON 后需要计算并添加 `apySpread` 字段：

```typescript
interface MarketWithSpread extends FormattedReserveData {
  apySpread: number | null; // totalSupplyApy - totalBorrowApy
}

// 计算 spread
const dataWithSpread: MarketWithSpread[] = formattedData.map(item => ({
  ...item,
  apySpread: item.totalBorrowApy !== null 
    ? item.totalSupplyApy - item.totalBorrowApy 
    : null
}));
```

### 前端排序逻辑（列头双向箭头）

前端实现列头排序：
- 每个可排序列显示双向箭头图标（⇅）
- 点击后切换状态：无排序 → 升序（↑）→ 降序（↓）→ 无排序
- 排序逻辑：
  - `totalSupplyApy`：降序用于 Lend 场景
  - `totalBorrowApy`：升序用于 Borrow 场景（null 值排在最后）
  - `apySpread`：升序用于 Looping 场景（负数优先，null 值排在最后）

### 前端 APY/APR 切换逻辑

前端需要实现 APY/APR 切换：
1. **状态管理**：使用 React state 存储当前模式（`'apy' | 'apr'`）
2. **计算逻辑**：
   - **APY 模式**（默认）：使用后端返回的 `totalSupplyApy`, `totalBorrowApy` 等（已经是 APY）
   - **APR 模式**：需要将激励部分的 APY 转换回 APR
     - 原生 APY 保持不变（因为后端原始数据就是 APY）
     - 激励部分：使用 `convertAprToApy` 的反向函数，或后端返回原始 APR 数据
3. **显示更新**：切换模式时，重新计算所有显示值

**实现建议**：后端返回数据时，同时返回 APY 和原始 APR 数据，前端根据模式选择显示哪个。

### UI 设计（列头双向箭头）

- **列头样式**：每个可排序列显示列名 + 双向箭头图标（⇅）
- **排序状态**：
  - 无排序：灰色双向箭头（⇅）
  - 升序：蓝色向上箭头（↑）
  - 降序：蓝色向下箭头（↓）
- **点击区域**：整个列头可点击，包括文字和箭头
- **视觉反馈**：hover 时高亮，点击时有轻微动画效果

## 技术栈选择

### 后端
- **框架**: Express.js
- **语言**: TypeScript
- **数据**: 复用现有的数据获取逻辑
- **Aave SDK**: 继续使用 `@aave/client`（后端 Node.js SDK，用于服务端数据获取）
  - 注意：`@aave/react` 是前端 React hooks，用于浏览器中的链上交互（连接钱包、提交交易等）
  - 当前场景只需要数据展示，无需链上交互，所以 `@aave/client` 足够
  - 未来如果需要前端交互功能（如用户连接钱包、提交 supply/borrow 交易），再考虑引入 `@aave/react`

### 前端
- **框架**: React 18
- **构建工具**: Vite
- **语言**: TypeScript
- **样式**: Tailwind CSS
- **HTTP 客户端**: axios

## 显示字段

表格需要显示的关键字段：

- **Token Symbol**：代币符号（主显示）
- **Token Name**：代币名称（副显示，小字）
- **Chain**：链名（用于筛选）
- **Supply APY**：原生供应 APY（从数据中的 `supplyApy` 字段，已经是百分比字符串）
- **Borrow APY**：原生借贷 APY（从数据中的 `borrowApy` 字段，可能是百分比字符串或 null）
- **Total Supply APY**：总供应 APY（包含所有激励，从 `totalSupplyApy` 字段，是小数）
- **Total Borrow APY**：总借贷 APY（包含所有激励，从 `totalBorrowApy` 字段，是小数或 null）
- **APY Spread**：差值 = Total Supply APY - Total Borrow APY（负数用橙色高亮）
- **Incentive Breakdown**：激励详情（可展开查看，可选功能）

## 数据字段说明

### FormattedReserveData 接口（从现有代码复用）

主要字段：
- `marketName`: 市场名称
- `chainName`: 链名称
- `chainId`: 链 ID
- `tokenName`: 代币名称
- `tokenSymbol`: 代币符号
- `tokenAddress`: 代币合约地址
- `supplyApy`: 原生供应 APY（字符串，百分比格式，如 "2.16"）
- `borrowApy`: 原生借贷 APY（字符串或 null，百分比格式）
- `totalSupplyApy`: 总供应 APY（数字，小数格式，如 0.0216）
- `totalBorrowApy`: 总借贷 APY（数字或 null，小数格式）
- `totalIncentiveSupplyApy`: 总激励供应 APY（数字，小数格式）
- `totalIncentiveBorrowApy`: 总激励借贷 APY（数字，小数格式）
- 其他激励字段（Merit、Merkl、Brevis）...

### 新增字段（后端计算）

- `apySpread`: APY 差值 = totalSupplyApy - totalBorrowApy（数字或 null，小数格式）

## 环境配置

### 后端环境变量（可选）

- `PORT`: 服务器端口（默认 3001）
- `FRONTEND_URL`: 前端 URL（用于 CORS，默认 http://localhost:5173）

### 前端环境变量

创建 `frontend/.env` 文件：

```
VITE_API_URL=http://localhost:3001/api
```

## 开发注意事项

1. **数据文件路径**：
   - 后端需要访问 `../data/aave-formatted-data.json`（相对于 backend 目录）
   - 确保数据文件存在，否则 API 会返回空数组

2. **代码复用**：
   - 后端 `fetchService.ts` 通过执行主项目的 `npm run dev` 来复用数据获取逻辑
   - 类型定义需要与主项目的 `FormattedReserveData` 保持一致

3. **数据更新**：
   - 定时任务每 1 分钟执行一次
   - 如果上一次更新还在进行中（通常需要 10-30 秒），跳过本次更新
   - 手动刷新不受最小间隔限制，但会受到"正在更新中"的检查

4. **并发处理**：
   - 使用文件锁防止并发更新
   - 内存缓存是线程安全的，可以处理大量并发请求
   - 前端并发请求不会触发数据更新，只读取缓存数据

5. **错误处理**：
   - 单个 API 失败不影响其他数据源
   - 记录错误日志，但不中断整个更新流程
   - 前端需要处理错误状态和加载状态

## 后续扩展功能（预留）

- 数据自动刷新（定时任务，如每小时）- **已实现（每1分钟）**
- 导出 CSV/Excel 功能
- 详细页面（单个代币的详细信息，包括所有激励来源）
- 历史 APY 趋势图
- 收藏/关注功能
- 价格信息集成（显示代币当前价格）
- 用户交互功能（连接钱包、提交交易）- 需要引入 `@aave/react`

## 参考文档

- 主项目 README：`README.md`
- 后端 README：`README-BACKEND.md`
- 前端 README：`README-FRONTEND.md`
- 设置指南：`SETUP.md`
- 现有数据获取逻辑：`src/index.ts`
- 数据文件：`data/aave-formatted-data.json`

