# v0 前端配置指南

本文档介绍如何在 v0 前端中配置连接到远程 API 服务。

## API 端点信息

- **API 基础 URL**: `http://43.247.134.242:3001/api`
- **健康检查**: `http://43.247.134.242:3001/health`

## API 端点列表

### 1. 获取市场数据
```
GET http://43.247.134.242:3001/api/markets
```

**查询参数**:
- `sort`: 排序字段（totalSupplyApy, totalBorrowApy, apySpread, supplyApy, borrowApy）
- `order`: 排序方向（asc, desc）
- `chain`: 链名筛选（多个用逗号分隔）
- `token`: 代币符号搜索
- `minSupplyApy`: 最小 Supply APY
- `maxBorrowApy`: 最大 Borrow APY

**响应示例**:
```json
{
  "data": [
    {
      "marketName": "AaveV3Ethereum",
      "chainName": "Ethereum",
      "chainId": 1,
      "tokenSymbol": "USDC",
      "tokenAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "supplyApy": "3.27",
      "borrowApy": "4.73",
      "totalSupplyApy": 0.0327,
      "totalBorrowApy": 0.0473,
      "apySpread": -0.0146
    }
  ],
  "lastUpdated": "2026-01-06T01:17:05.259Z",
  "isStale": false,
  "updateInProgress": false
}
```

### 2. 获取统计信息
```
GET http://43.247.134.242:3001/api/markets/stats
```

**响应示例**:
```json
{
  "totalMarkets": 230,
  "totalChains": 17,
  "averageSupplyApy": 2.5,
  "averageBorrowApy": 4.2
}
```

### 3. 获取链列表
```
GET http://43.247.134.242:3001/api/markets/chains
```

**响应示例**:
```json
["Ethereum", "Polygon", "Arbitrum", "Optimism", ...]
```

### 4. 手动刷新数据
```
POST http://43.247.134.242:3001/api/markets/refresh
```

**响应示例**:
```json
{
  "status": "updating",
  "message": "Update started",
  "lastUpdated": "2026-01-06T01:17:05.259Z"
}
```

### 5. 健康检查
```
GET http://43.247.134.242:3001/health
```

**响应示例**:
```json
{
  "status": "ok",
  "timestamp": "2026-01-06T01:17:03.965Z"
}
```

## v0 前端配置方法

### 方法 1: 在 v0 代码中直接使用 API URL

在 v0 生成的代码中，找到 API 调用部分，替换为：

```typescript
// 定义 API 基础 URL
const API_BASE_URL = 'http://43.247.134.242:3001/api';

// 获取市场数据
const response = await fetch(`${API_BASE_URL}/markets`);
const data = await response.json();
```

### 方法 2: 使用环境变量（如果 v0 支持）

如果 v0 支持环境变量，可以设置：

```env
VITE_API_URL=http://43.247.134.242:3001/api
# 或
NEXT_PUBLIC_API_URL=http://43.247.134.242:3001/api
```

### 方法 3: 创建 API 服务文件

创建一个统一的 API 服务文件：

```typescript
// api.ts
const API_BASE_URL = 'http://43.247.134.242:3001/api';

export const marketsApi = {
  async getMarkets(params?: {
    sort?: string;
    order?: 'asc' | 'desc';
    chain?: string;
    token?: string;
    minSupplyApy?: number;
    maxBorrowApy?: number;
  }) {
    const queryParams = new URLSearchParams();
    if (params?.sort) queryParams.append('sort', params.sort);
    if (params?.order) queryParams.append('order', params.order);
    if (params?.chain) queryParams.append('chain', params.chain);
    if (params?.token) queryParams.append('token', params.token);
    if (params?.minSupplyApy !== undefined) queryParams.append('minSupplyApy', params.minSupplyApy.toString());
    if (params?.maxBorrowApy !== undefined) queryParams.append('maxBorrowApy', params.maxBorrowApy.toString());
    
    const url = `${API_BASE_URL}/markets${queryParams.toString() ? '?' + queryParams.toString() : ''}`;
    const response = await fetch(url);
    return response.json();
  },

  async getStats() {
    const response = await fetch(`${API_BASE_URL}/markets/stats`);
    return response.json();
  },

  async getChains() {
    const response = await fetch(`${API_BASE_URL}/markets/chains`);
    return response.json();
  },

  async refreshMarkets() {
    const response = await fetch(`${API_BASE_URL}/markets/refresh`, {
      method: 'POST',
    });
    return response.json();
  },
};
```

## 使用示例

### React 组件示例

```typescript
import { useState, useEffect } from 'react';

function MarketsTable() {
  const [markets, setMarkets] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchMarkets() {
      try {
        const response = await fetch('http://43.247.134.242:3001/api/markets');
        const data = await response.json();
        setMarkets(data.data);
        setLoading(false);
      } catch (error) {
        console.error('Failed to fetch markets:', error);
        setLoading(false);
      }
    }
    
    fetchMarkets();
  }, []);

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      {markets.map((market) => (
        <div key={market.tokenAddress}>
          <h3>{market.tokenSymbol}</h3>
          <p>Supply APY: {market.totalSupplyApy * 100}%</p>
          <p>Borrow APY: {market.totalBorrowApy * 100}%</p>
        </div>
      ))}
    </div>
  );
}
```

### Next.js API Route 示例（如果需要代理）

如果遇到 CORS 问题，可以在 Next.js 中创建 API 路由作为代理：

```typescript
// pages/api/markets.ts 或 app/api/markets/route.ts
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const queryString = searchParams.toString();
  
  const response = await fetch(
    `http://43.247.134.242:3001/api/markets${queryString ? '?' + queryString : ''}`
  );
  const data = await response.json();
  
  return Response.json(data);
}
```

## CORS 配置

后端已配置允许所有来源访问，包括：
- 本地开发环境（localhost）
- v0 前端
- 任何其他前端应用

如果遇到 CORS 错误，请检查：
1. 后端服务是否正常运行
2. 浏览器控制台的错误信息
3. 网络请求是否成功发送

## 测试 API

### 使用 curl 测试

```bash
# 健康检查
curl http://43.247.134.242:3001/health

# 获取市场数据
curl http://43.247.134.242:3001/api/markets

# 获取统计信息
curl http://43.247.134.242:3001/api/markets/stats

# 获取链列表
curl http://43.247.134.242:3001/api/markets/chains

# 手动刷新数据
curl -X POST http://43.247.134.242:3001/api/markets/refresh
```

### 使用浏览器测试

直接在浏览器中访问：
- `http://43.247.134.242:3001/health`
- `http://43.247.134.242:3001/api/markets`

## 注意事项

1. **API 地址**: 使用 `http://43.247.134.242:3001/api`（注意是 HTTP，不是 HTTPS）
2. **数据更新**: 数据每 1 分钟自动更新一次
3. **首次加载**: 服务首次启动时可能需要几分钟来获取初始数据
4. **网络访问**: 确保前端可以访问服务器的 3001 端口

## 常见问题

### 1. CORS 错误

后端已配置允许所有来源，如果仍有问题：
- 检查后端服务是否正常运行
- 查看浏览器控制台的完整错误信息

### 2. 网络请求失败

- 检查服务器是否可访问：`ping 43.247.134.242`
- 检查端口是否开放：`curl http://43.247.134.242:3001/health`
- 检查防火墙配置

### 3. 数据为空

- 首次启动时数据可能需要几分钟加载
- 可以手动触发刷新：`POST /api/markets/refresh`
- 检查后端日志：`pm2 logs aave-backend`

