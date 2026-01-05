# Backend API Server

## 安装依赖

```bash
cd backend
npm install
```

## 开发模式运行

```bash
npm run dev
```

服务器将在 `http://localhost:3001` 启动

## 构建

```bash
npm run build
npm start
```

## API 端点

### GET /api/markets

获取所有市场数据

查询参数：
- `sort`: 排序字段（totalSupplyApy, totalBorrowApy, apySpread, supplyApy, borrowApy）
- `order`: 排序方向（asc, desc）
- `chain`: 链名筛选（多个用逗号分隔）
- `token`: 代币符号搜索
- `minSupplyApy`: 最小 Supply APY
- `maxBorrowApy`: 最大 Borrow APY

响应：
```json
{
  "data": [...],
  "lastUpdated": "2024-01-01T00:00:00.000Z",
  "isStale": false,
  "updateInProgress": false
}
```

### GET /api/markets/stats

获取统计信息

### GET /api/markets/chains

获取所有链列表

### POST /api/markets/refresh

手动触发数据刷新

## 数据更新

后端使用定时任务每 1 分钟自动更新数据。数据从 `../data/aave-formatted-data.json` 读取。

