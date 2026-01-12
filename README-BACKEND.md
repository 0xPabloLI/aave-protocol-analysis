# Backend API Server

## 安装依赖

\`\`\`bash
cd backend
npm install
\`\`\`

## 开发模式运行

\`\`\`bash
npm run dev
\`\`\`

服务器将在 `http://localhost:3001` 启动

## 构建

\`\`\`bash
npm run build
npm start
\`\`\`

## API 端点

### 数据新鲜度自动检查机制

**重要更新**：所有 API 端点现在都会自动检查数据新鲜度（1分钟窗口）。如果数据过期，会自动触发更新并等待完成后返回最新数据。

- ✅ 无需手动调用刷新端点
- ✅ 自动并发控制，防止重复更新
- ✅ 更新失败时返回缓存数据
- ❌ 已移除 `POST /api/markets/refresh` 端点

详细说明请参考：[backend/DATA-FRESHNESS-MECHANISM.md](./backend/DATA-FRESHNESS-MECHANISM.md)

### GET /api/markets

获取所有市场数据（自动检查数据新鲜度）

查询参数：
- `sort`: 排序字段（totalSupplyApy, totalBorrowApy, apySpread, supplyApy, borrowApy）
- `order`: 排序方向（asc, desc）
- `chain`: 链名筛选（多个用逗号分隔）
- `token`: 代币符号搜索
- `minSupplyApy`: 最小 Supply APY
- `maxBorrowApy`: 最大 Borrow APY

响应：
\`\`\`json
{
  "data": [...],
  "lastUpdated": "2024-01-01T00:00:00.000Z",
  "isStale": false,
  "updateInProgress": false
}
\`\`\`

### GET /api/markets/stats

获取统计信息（自动检查数据新鲜度）

响应：
```json
{
  "totalMarkets": 100,
  "totalChains": 5,
  "totalTokens": 20,
  "chains": ["Ethereum", "Polygon", ...]
}
```

### GET /api/markets/chains

获取所有链列表（自动检查数据新鲜度）

响应：
```json
["Ethereum", "Polygon", "Arbitrum", ...]
```

### GET /api/markets/list

获取所有市场列表（自动检查数据新鲜度）

响应：
```json
[
  {"marketName": "Main Market", "chainName": "Ethereum"},
  ...
]
```

## 数据更新

后端使用定时任务每 1 分钟自动更新数据。数据从 `../data/aave-formatted-data.json` 读取。
