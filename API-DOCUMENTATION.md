# API 接口文档

## 概述

本文档描述了 Aave 市场数据服务的 API 接口和数据格式。服务提供 Aave V3 协议的市场数据，包括基础 APY、协议激励、Merit APR、Merkl APR 和 Brevis APR 等激励信息。

## 基础信息

- **服务地址**: `http://localhost:3001` (开发环境)
- **API 基础路径**: `/api/markets`
- **数据格式**: JSON
- **字符编码**: UTF-8

## 数据模型

### FormattedReserveData

市场储备数据的完整结构，包含所有激励信息。

```typescript
interface FormattedReserveData {
  // 基础信息
  marketName: string;                    // 市场名称，如 "AaveV3Arbitrum"
  chainName: string;                     // 链名称，如 "Arbitrum"
  chainId: number;                       // 链 ID，如 42161
  tokenName: string;                     // 代币名称，如 "Aave Token"
  tokenSymbol: string;                   // 代币符号，如 "AAVE"
  tokenAddress: string;                  // 底层代币地址
  aTokenAddress: string | null;          // aToken 地址
  vTokenAddress: string | null;          // variableDebtToken 地址
  
  // 基础 APY
  supplyApy?: number;                    // Supply APY（百分比数值，如 2.07 表示 2.07%），如果为 undefined 则在 JSON 中不出现
  borrowApy?: number;                    // Borrow APY（百分比数值，如 3.97 表示 3.97%），如果为 undefined 则在 JSON 中不出现
  
  // 协议激励（来自 Aave 协议）
  supplyIncentives?: number[];           // Protocol supply incentives（百分比数值数组），如果为空数组则在 JSON 中不出现
  borrowIncentives?: number[];           // Protocol borrow incentives（百分比数值数组），如果为空数组则在 JSON 中不出现
  
  // Merit APR 激励（可选字段，仅在存在数据时出现）
  meritSupplys?: Array<{
    apr: number;                         // APR 百分比值（如 5.2 表示 5.2%）
    selfApr?: number;                     // Self APR 百分比值（如果有对应的 self- 前缀的 key）
    link: string;                         // Merit 活动详情页链接
    startDate: string;                    // 活动开始日期
    endDate: string;                      // 活动结束日期
    requiredBorrowTokens?: string[];      // 需要 borrow 的 token 列表（用于 supply with borrow requirement），'multiple' 表示任意 token
  }>;
  meritBorrows?: Array<{
    apr: number;                         // APR 百分比值（如 5.2 表示 5.2%）
    selfApr?: number;                     // Self APR 百分比值（如果有对应的 self- 前缀的 key）
    link: string;                         // Merit 活动详情页链接
    startDate: string;                    // 活动开始日期
    endDate: string;                      // 活动结束日期
    requiredSupplyTokens?: string[];      // 需要 supply 的 token 列表（用于 borrow with supply requirement），'multiple' 表示任意 token
  }>;
  
  // Merkl 详细机会数据（可选字段，仅在存在数据时出现）
  merklSupplys?: MerklOpportunityGroup[];
  merklBorrows?: MerklOpportunityGroup[];
  merklHolds?: MerklOpportunityGroup[];
  
  // Brevis APR 激励（可选字段）
  brevisSupplyApr?: number;               // Brevis Network Linea Surge Supply APR（百分比数值），如果为 undefined 则在 JSON 中不出现
  brevisBorrowApr?: number;               // Brevis Network Linea Surge Borrow APR（百分比数值），如果为 undefined 则在 JSON 中不出现
}
```

### MerklOpportunityGroup

Merkl 机会分组数据，用于 JSON 输出，避免重复。

```typescript
interface MerklOpportunityGroup {
  opportunityLink: string;              // Opportunity 详情页链接
  name?: string;                        // Opportunity 名称（可选）
  description?: string;                 // Opportunity 描述（可选）
  breakdowns: MerklCampaignBreakdown[]; // 该 opportunity 的所有 breakdowns
}

interface MerklCampaignBreakdown {
  campaignApr: number;                  // 活动 APR（百分比数值）
  campaignStartedAt: string;            // 活动开始时间（ISO 8601）
  campaignEndedAt: string;              // 活动结束时间（ISO 8601）
  campaignId: string;                   // 活动 ID
  pointsPerThousandUsd?: number;        // Tydro 协议的 points/1000USD 值（可选）
  dailyPoints?: number;                 // Tydro 协议的每日 points（可选）
}
```

## API 端点

### 1. 获取所有市场数据

**端点**: `GET /api/markets`

**描述**: 获取所有市场数据，包含完整的激励信息。如果数据超过 1 分钟未更新，会自动触发后台更新。

**请求参数**: 无

**响应格式**:

```typescript
interface MarketsResponse {
  data: MarketWithSpread[];            // 市场数据数组
  lastUpdated: string;                  // 最后更新时间（ISO 8601）
  isStale: boolean;                     // 数据是否过期（超过 1 分钟）
  updateInProgress: boolean;           // 是否正在更新中
}
```

**响应示例**:

```json
{
  "data": [
    {
      "marketName": "AaveV3Arbitrum",
      "chainName": "Arbitrum",
      "chainId": 42161,
      "tokenName": "Dai Stablecoin",
      "tokenSymbol": "DAI",
      "tokenAddress": "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      "aTokenAddress": "0x82E64f49Ed5EC1bC6e43DAD4FC8Af9bb3A2312EE",
      "vTokenAddress": "0x8619d80FB0141ba7F184CbF22fd724116D9f7ffC",
      "supplyApy": 2.07,
      "borrowApy": 3.97,
      "supplyIncentives": [0.5, 1.2],
      "borrowIncentives": [0.3],
      "meritSupplys": [
        {
          "apr": 5.2,
          "selfApr": 2.1,
          "link": "https://apps.aavechan.com/merit/arbitrum-supply-dai",
          "startDate": "Thu Jan 01 2026",
          "endDate": "Thu Jan 15 2026"
        }
      ],
      "meritBorrows": [
        {
          "apr": 3.5,
          "link": "https://apps.aavechan.com/merit/arbitrum-borrow-dai",
          "startDate": "Thu Jan 01 2026",
          "endDate": "Thu Jan 15 2026",
          "requiredSupplyTokens": ["USDC"]
        }
      ],
      "merklSupplys": [
        {
          "opportunityLink": "https://app.merkl.xyz/opportunities/arbitrum/MULTILOG_DUTCH/0xe0b9e069b0cb46329e7d37e87e635a84ea772fcf",
          "breakdowns": [
            {
              "campaignApr": 0.329,
              "campaignStartedAt": "2026-01-07T13:00:00.000Z",
              "campaignEndedAt": "2026-01-21T13:00:00.000Z",
              "campaignId": "9692233454321271392"
            }
          ]
        }
      ],
      "merklBorrows": [],
      "brevisSupplyApr": 1.5
    }
  ],
  "lastUpdated": "2026-01-13T11:00:06.895Z",
  "isStale": false,
  "updateInProgress": false
}
```

**状态码**:
- `200`: 成功
- `500`: 服务器错误

**注意事项**:
- 所有排序和过滤逻辑应在客户端处理
- 如果数据过期，会自动触发后台更新，但响应会立即返回当前缓存数据
- 响应中的 `updateInProgress` 字段表示是否有更新正在进行

---

### 2. 获取统计信息

**端点**: `GET /api/markets/stats`

**描述**: 获取市场数据的统计信息，包括总池数、链数、代币数等。

**请求参数**: 无

**响应格式**:

```json
{
  "totalPools": 231,
  "totalChains": 15,
  "totalTokens": 45,
  "chains": ["Arbitrum", "Avalanche", "Base", ...]
}
```

**状态码**:
- `200`: 成功
- `500`: 服务器错误

---

### 3. 获取所有链列表

**端点**: `GET /api/markets/chains`

**描述**: 获取所有支持的链名称列表（已排序）。

**请求参数**: 无

**响应格式**:

```json
["Arbitrum", "Avalanche", "Base", "Celo", ...]
```

**状态码**:
- `200`: 成功
- `500`: 服务器错误

---

### 4. 获取市场列表

**端点**: `GET /api/markets/list`

**描述**: 获取所有市场列表（用于前端过滤器），返回去重后的市场-链组合。

**请求参数**: 无

**响应格式**:

```json
[
  {
    "marketName": "AaveV3Arbitrum",
    "chainName": "Arbitrum"
  },
  {
    "marketName": "AaveV3Avalanche",
    "chainName": "Avalanche"
  }
]
```

**状态码**:
- `200`: 成功
- `500`: 服务器错误

---

### 5. 健康检查

**端点**: `GET /health`

**描述**: 检查服务健康状态。

**请求参数**: 无

**响应格式**:

```json
{
  "status": "ok",
  "timestamp": "2026-01-13T11:00:06.895Z"
}
```

**状态码**:
- `200`: 服务正常

---

## 数据说明

### 字段类型说明

1. **APY/APR 格式**:
   - `supplyApy` / `borrowApy`: 数值格式的百分比（如 `2.07` 表示 2.07%），如果为 `undefined` 则在 JSON 中不出现
   - `supplyIncentives` / `borrowIncentives`: 数值数组，每个元素为百分比数值（如 `[0.5, 1.2]` 表示 0.5% 和 1.2%），如果为空数组则在 JSON 中不出现
   - `meritSupplys` / `meritBorrows`: 对象数组，每个对象包含：
     - `apr`: 数值格式的百分比（如 `5.2` 表示 5.2%）
     - `selfApr`: 可选的 Self APR 百分比值（如果有对应的 self- 前缀的 key）
     - `link`: Merit 活动详情页链接
     - `startDate` / `endDate`: 活动时间范围
     - `requiredBorrowTokens` / `requiredSupplyTokens`: 可选的条件要求 token 列表
   - `merklSupplys` / `merklBorrows` / `merklHolds`: 对象数组，每个对象包含 `opportunityLink` 和 `breakdowns` 数组
   - `brevisSupplyApr` / `brevisBorrowApr`: 数值格式的百分比，如果为 `undefined` 则在 JSON 中不出现

2. **可选字段和空值处理**:
   - 标记为 `?` 的字段为可选字段
   - 如果字段值为 `undefined` 或未赋值，在 JSON 响应中该字段**不会出现**（而不是 `null`）
   - 空数组 `[]` 会被转换为 `undefined`，在 JSON 中不出现
   - `null` 会被转换为 `undefined`，在 JSON 中不出现（通过 JSON.stringify 的 replacer 函数处理）
   - **重要**：数值 `0` 是有效值，会保留在 JSON 中（不会被省略）
   - 所有激励相关字段都是可选的，包括：
     - `supplyApy` / `borrowApy`
     - `supplyIncentives` / `borrowIncentives`
     - `meritSupplys` / `meritBorrows`
     - `merklSupplys` / `merklBorrows` / `merklHolds`
     - `brevisSupplyApr` / `brevisBorrowApr`
   - 以下字段如果为空（空数组或 undefined），会在 JSON 中被省略：
     - `supplyIncentives` / `borrowIncentives`（空数组时）
     - `meritSupplys` / `meritBorrows`（空数组时）
     - `merklSupplys` / `merklBorrows` / `merklHolds`（空数组时）
     - `aTokenAddress` / `vTokenAddress`（null 时）
     - `supplyApy` / `borrowApy`（undefined 时）
     - `brevisSupplyApr` / `brevisBorrowApr`（undefined 时）

3. **Merit 数据结构说明**:
   - `meritSupplys` 和 `meritBorrows` 是数组，每个元素代表一个 Merit 激励活动
   - 如果同一个活动有 self 和非 self 版本，它们会合并到同一条目中：
     - `apr` 字段存储非 self 版本的 APR
     - `selfApr` 字段存储 self 版本的 APR（如果存在）
   - `requiredBorrowTokens` 和 `requiredSupplyTokens` 用于表示条件激励：
     - 如果 `meritSupplys` 条目包含 `requiredBorrowTokens`，表示需要先 borrow 指定的 token 才能获得该 supply APR
     - 如果 `meritBorrows` 条目包含 `requiredSupplyTokens`，表示需要先 supply 指定的 token 才能获得该 borrow APR
     - `'multiple'` 表示任意 token 都可以满足条件

### 数据来源

- **基础 APY**: 来自 Aave 协议 API
- **协议激励**: 来自 Aave 协议的 `reserve.incentives`
- **Merit APR**: 来自 `https://apps.aavechan.com/api/merit/aprs`
- **Merkl APR**: 来自 `https://api.merkl.xyz/v4/opportunities`
- **Brevis APR**: 来自 Brevis Network Linea Surge API

### 数据更新机制

- 所有 API 端点会自动检查数据新鲜度
- 如果数据超过 1 分钟未更新，会自动触发后台更新
- 使用锁机制防止并发更新
- 更新过程中，API 会立即返回当前缓存数据
- 响应中的 `isStale` 和 `updateInProgress` 字段可用于判断数据状态

## 错误处理

### 错误响应格式

```json
{
  "error": "Internal server error",
  "message": "具体错误信息"
}
```

### 常见错误码

- `500`: 服务器内部错误
  - 数据文件读取失败
  - 数据更新失败
  - 其他服务器错误

## CORS 配置

服务已配置 CORS 中间件，支持跨域请求。具体配置请参考 `backend/src/middleware/cors.ts`。

## 示例代码

### JavaScript/TypeScript

```typescript
// 获取所有市场数据
const response = await fetch('http://localhost:3001/api/markets');
const data = await response.json();
console.log(data.data); // 市场数据数组
console.log(data.lastUpdated); // 最后更新时间
console.log(data.isStale); // 是否过期
```

### cURL

```bash
# 获取所有市场数据
curl http://localhost:3001/api/markets

# 获取统计信息
curl http://localhost:3001/api/markets/stats

# 获取链列表
curl http://localhost:3001/api/markets/chains

# 健康检查
curl http://localhost:3001/health
```

## 版本信息

- **API 版本**: 2.0
- **文档更新时间**: 2026-01-13
- **最后更新**: 
  - 重构 Merit 数据结构：统一为 `meritSupplys` 和 `meritBorrows` 数组，每个条目包含完整的活动信息（apr, selfApr, link, startDate, endDate）
  - 统一命名：所有激励字段使用复数形式（meritSupplys, meritBorrows, merklSupplys, merklBorrows, merklHolds）
  - 数据类型优化：APY/APR 值统一为 `number` 类型（百分比数值），不再使用字符串
  - 协议激励改为数值数组：`supplyIncentives` 和 `borrowIncentives` 现在为 `number[]`
  - 移除 Merkl APR 总和字段：`merklSupplyApr`、`merklBorrowApr`、`merklHoldApr` 已移除，数据已包含在对应的 opportunities 中

## 注意事项

1. **数据格式一致性**: 
   - 所有 APY/APR 值都使用 `number` 类型（百分比数值），如 `2.07` 表示 2.07%
   - 不再使用字符串格式的百分比值
2. **可选字段**: 可选字段在 JSON 中可能不存在，访问前应检查字段是否存在（使用 `'field' in obj` 或 `obj.field !== undefined`）
3. **空值处理**: 
   - `null` 和 `undefined` 在 JSON 中都不会出现（通过 replacer 函数处理）
   - 空数组会被转换为 `undefined` 并省略
   - 数值 `0` 是有效值，会保留在 JSON 中
4. **Merit 数据结构**:
   - `meritSupplys` 和 `meritBorrows` 是数组，可能包含多个激励活动
   - 每个条目都包含完整的活动信息（链接、时间范围等）
   - 如果活动有 self 版本，会在同一条目中通过 `selfApr` 字段表示
5. **Merkl 数据结构**:
   - 不再提供 APR 总和字段，所有数据都在 `merklSupplys`、`merklBorrows`、`merklHolds` 数组中
   - 每个 opportunity 包含多个 breakdowns（活动详情）
6. **数据新鲜度**: 建议根据 `isStale` 和 `lastUpdated` 字段判断数据是否可用
7. **更新机制**: 数据更新是异步的，更新过程中会返回缓存数据
8. **过滤逻辑**: 所有排序和过滤应在客户端完成，API 不提供查询参数
