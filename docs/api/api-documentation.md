# API 接口文档

## 概述

本文档描述了 Aave 市场数据服务的 API 接口和数据格式。服务提供 Aave V3 协议的市场数据，包括基础 APY、协议激励、Merit APR、Merkl APR 和 Brevis APR 等激励信息。

## 基础信息

- **服务地址**: `http://localhost:3001` (开发环境)
- **API 基础路径**:
  - `/api/markets` - 市场数据
  - `/api/coingecko-categories` - CoinGecko 分类数据
  - `/api/coingecko-fdv` - CoinGecko FDV 数据
  - `/api/campaigns` - Merkl 活动预测（含 `/forecast-states`）
  - `/api/rate-inputs` - 利率输入/储备参数
  - `/health`、`/api/health` - 健康检查
- **数据格式**: JSON
- **字符编码**: UTF-8
- **端点总数**: **7 个**（7 条 URL；若将 `GET /health` 与 `GET /api/health` 视为同一逻辑则共 6 个逻辑端点）

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
    startBlock?: string;                  // 活动开始区块（可选）
    endBlock?: string;                    // 活动结束区块（可选）
    requiredBorrowTokens?: string[];      // 需要 borrow 的 token 列表（用于 supply with borrow requirement），'multiple' 表示任意 token
  }>;
  meritBorrows?: Array<{
    apr: number;                         // APR 百分比值（如 5.2 表示 5.2%）
    selfApr?: number;                     // Self APR 百分比值（如果有对应的 self- 前缀的 key）
    link: string;                         // Merit 活动详情页链接
    startDate: string;                    // 活动开始日期
    endDate: string;                      // 活动结束日期
    startBlock?: string;                  // 活动开始区块（可选）
    endBlock?: string;                    // 活动结束区块（可选）
    requiredSupplyTokens?: string[];      // 需要 supply 的 token 列表（用于 borrow with supply requirement），'multiple' 表示任意 token
  }>;
  
  // Merkl 详细机会数据（可选字段，仅在存在数据时出现）
  merklSupplys?: MerklOpportunityGroup[];
  merklBorrows?: MerklOpportunityGroup[];
  merklHolds?: MerklOpportunityGroup[];
  
  // Brevis APR 激励（可选字段，仅在存在数据时出现）
  brevisSupplys?: Array<{
    apr: number;                         // APR 百分比值（如 1.5 表示 1.5%）
    link: string;                        // Brevis 活动详情页链接
    startDate: string;                    // 活动开始日期
    endDate: string;                      // 活动结束日期
    name: string;                        // 活动名称
  }>;
  brevisBorrows?: Array<{
    apr: number;                         // APR 百分比值（如 1.5 表示 1.5%）
    link: string;                        // Brevis 活动详情页链接
    startDate: string;                    // 活动开始日期
    endDate: string;                      // 活动结束日期
    name: string;                        // 活动名称
  }>;
}
```

### MerklOpportunityGroup

Merkl 机会分组数据，用于 JSON 输出，避免重复。

```typescript
interface MerklOpportunityGroup {
  link: string;                         // Opportunity 详情页链接
  name?: string;                        // Opportunity 名称（可选）
  message?: string;                     // Opportunity 消息/描述（可选）
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

**描述**: 获取所有市场数据，包含完整的激励信息。如果数据超过 1 分钟未更新，会自动触发后台更新。前端若需要 market filter 列表，应从 `data` 中按 `{ marketName, chainName }` 去重推导。

**请求参数**: 无

**响应格式**:

```typescript
interface MarketsResponse {
  data: MarketWithSpread[];            // 市场数据数组
  lastUpdated: string;                  // 最后更新时间（ISO 8601）
  isStale: boolean;                     // 数据是否过期（超过 1 分钟）
  updateInProgress: boolean;           // 是否正在更新中
  tokenPrices?: Record<string, {       // 代币价格索引（仅 GET /api/markets 返回，仅含 price + source）
    price: number;
    source: string;                    // 如 "aave" | "opportunity" | "reward"
  }>;
}
```

**Token 价格（tokenPrices）**：仅在此接口 **`GET /api/markets`** 的响应根级别返回。key 为 `chainId:tokenAddress`（小写），用于与储备数据中的 `chainId` + `tokenAddress` 对应。

- **覆盖范围**：包含 **所有 reserve 的 underlying token** 的 USD 价格（来源 `aave`）。Merkl 价格（来源 `opportunity` / `reward`）仅作为补充：当某个 token 在 Aave 价格索引中不存在时（例如部分 reward token），才会出现在 `tokenPrices` 中。
- **来源字段**：`aave` 来源的价格来自 Aave markets 数据里的 `reserve.size.usdPerToken`（若缺失则回退 `reserve.usdExchangeRate`）。
- **缺省行为**：极少数 token 若本轮 Aave/Merkl 均未返回价格，则会沿用上一轮文件中该 token 的价格**仅当**上一轮文件的 `_metadata.timestamp` 在 3 倍正常更新周期内（3× backend stale 阈值，即 3 分钟）；超过则不沿用，避免长期保留已不再出现的 token 的过期价格。

**市场筛选列表**：本接口就是唯一权威快照。若 UI 需要 market 列表，请从 `data` 中去重，不要再引入额外的市场列表接口，否则会产生第二条快照路径并增加前后端缓存失配风险。

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
          "link": "https://app.merkl.xyz/opportunities/arbitrum/MULTILOG_DUTCH/0xe0b9e069b0cb46329e7d37e87e635a84ea772fcf",
          "name": "MultiLog Dutch Auction",
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
      "brevisSupplys": [
        {
          "apr": 1.5,
          "link": "https://brevis.network/linea-surge",
          "startDate": "Thu Jan 01 2026",
          "endDate": "Thu Jan 31 2026",
          "name": "Linea Surge Supply"
        }
      ]
    }
  ],
  "lastUpdated": "2026-01-13T11:00:06.895Z",
  "isStale": false,
  "updateInProgress": false,
  "tokenPrices": {
    "42161:0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": {
      "price": 1.001,
      "source": "opportunity"
    }
  }
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

### 2. 批量获取 Merkl Forecast States

**端点**: `GET /api/campaigns/forecast-states`

**请求参数**:
- `ids` (可选): 逗号分隔 campaignId 列表；省略时默认返回当前 markets 中全部 campaign 的状态。

**响应格式**:

```json
{
  "requested": 23,
  "items": [],
  "errors": []
}
```

其中：
- `items` 为成功计算的 campaign 状态数组（字段同单个接口）。
- `errors` 为失败项数组：`{ campaignId, status, message }`。

**状态码**:
- `200`: 成功（部分失败也返回 200，失败体现在 `errors`）
- `400`: `ids` 过多（最多 100）
- `500`: 服务端错误

---

## Merkl TVL 与分发进度口径

- Forecast 的 `latestTvl` 优先取 Merkl opportunities 的 `tvl`。
- 如果 opportunities 中没有可用 TVL，则回退到 `/v4/campaigns/{id}/metrics` 的 `tvlRecords`，并取**最新时间戳**对应的 `total`。
- `distributedSoFar` 使用 metrics 的 `dailyRewardsRecords` 做时间积分估算（按时间段累积 daily rate）。

以上均来自 Merkl API，不从 Aave SDK 直接读取 campaign 级 TVL。

### 3. 健康检查

**端点**: `GET /health` 或 `GET /api/health`

**描述**: 检查服务健康状态，返回服务状态和环境配置信息。两路径使用同一处理逻辑。

**请求参数**: 无

**响应格式**:

```json
{
  "status": "ok",
  "timestamp": "2026-01-13T11:00:06.895Z",
  "environment": {
    "nodeEnv": "development",
    "port": 3001,
    "corsMode": "allow-all",
    "frontendUrl": "not set",
    "allowedDevOrigins": "not set"
  }
}
```

**状态码**:
- `200`: 服务正常

**响应字段说明**:
- `status`: 服务状态，通常为 `"ok"`
- `timestamp`: 当前时间戳（ISO 8601 格式）
- `environment`: 环境配置信息
  - `nodeEnv`: Node.js 环境（development/production）
  - `port`: 服务端口号
  - `corsMode`: CORS 模式（`"whitelist"` 或 `"allow-all"`）
  - `frontendUrl`: 前端 URL（生产环境配置）
  - `allowedDevOrigins`: 允许的开发环境源（开发环境配置）

---

### 4. 获取 CoinGecko FDV 数据

**端点**: `GET /api/coingecko-fdv`

**描述**: 获取指定代币的完全稀释估值（FDV）。优先使用 CoinMarketCap API，失败时回退到 CoinGecko。缓存 TTL 与 FDV 预热 cron 一致（默认 5 分钟）。

**请求参数**: 无

**响应格式**:

```json
{
  "items": [
    {
      "id": "binancecoin",
      "symbol": "bnb",
      "name": "BNB",
      "fdvUsd": 123456789012,
      "source": "coinmarketcap"
    }
  ],
  "fetchedAt": "2026-03-09T12:00:00.000Z"
}
```

- `items`: FDV 条目数组（id、symbol、name、fdvUsd、source）
- `fetchedAt`: 数据获取时间（ISO 8601）
- `source`: `"coinmarketcap"` 或 `"coingecko_fallback"`

**状态码**: `200` 成功，`500` 服务端错误

**注意**: 需配置 `COINMARKETCAP_API_KEY` 使用 CoinMarketCap；否则仅使用 CoinGecko 回退。

---

### 5. 获取 CoinGecko 分类数据

**端点**: `GET /api/coingecko-categories`

**描述**: 获取 CoinGecko 分类数据，包括稳定币和以太坊相关代币的分类信息。数据缓存 6 小时。

**请求参数**: 无

**响应格式**:

```json
{
  "uniqueSymbolsStablecoins": ["USDT", "USDC", "DAI", "BUSD", ...],
  "uniqueSymbolsEth": ["WETH", "STETH", "RETH", "CBETH", ...]
}
```

**响应字段说明**:
- `uniqueSymbolsStablecoins`: 稳定币代币符号数组（去重后，已排序）
- `uniqueSymbolsEth`: 以太坊相关代币符号数组（包括 liquid-staked-eth、ether-fi-ecosystem、liquid-staking-tokens 分类，去重后，已排序）

**状态码**:
- `200`: 成功
- `500`: 服务器错误

**注意事项**:
- 数据来自 CoinGecko API，包含多个分类：
  - 稳定币：`stablecoins` 分类（2 页数据）
  - 以太坊相关：`liquid-staked-eth`、`ether-fi-ecosystem`、`liquid-staking-tokens` 分类
- 响应数据缓存 6 小时，减少对 CoinGecko API 的请求
- 如果设置了 `COINGECKO_API_KEY` 环境变量，会使用 API Key 进行认证

---

### 6. 获取利率输入（储备参数）

**端点**: `GET /api/rate-inputs`

**描述**: 获取储备利率计算所需参数（流动性、债务、利率曲线等），用于客户端或第三方计算 APY。数据来自 Aave 子图或链上，具有独立 TTL（与市场数据同族，默认 60 秒），不触发市场数据刷新。

**请求参数**（均为可选）:

| 参数 | 类型 | 说明 |
|------|------|------|
| `chainId` | 正整数 | 按链 ID 过滤 |
| `asset` | 字符串 | 按底层资产地址（小写）过滤 |
| `marketName` | 字符串 | 按市场名称过滤 |

**响应格式**:

```json
{
  "data": [
    {
      "chainId": 1,
      "marketName": "AaveV3Ethereum",
      "underlyingAsset": "0x...",
      "decimals": 18,
      "availableLiquidity": "...",
      "totalScaledVariableDebt": "...",
      "variableBorrowIndex": "...",
      "reserveFactor": "...",
      "variableRateSlope1": "...",
      "variableRateSlope2": "...",
      "baseVariableBorrowRate": "...",
      "optimalUtilisationRate": "..."
    }
  ],
  "lastUpdated": "2026-03-09T12:00:00.000Z",
  "isStale": false,
  "staleTimeMs": 60000,
  "sources": { ... }
}
```

**状态码**: `200` 成功，`400` 参数无效（如 `chainId` 非正整数），`500` 服务端错误

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
     - `startBlock` / `endBlock`: 可选的区块范围
     - `requiredBorrowTokens` / `requiredSupplyTokens`: 可选的条件要求 token 列表
   - `merklSupplys` / `merklBorrows` / `merklHolds`: 对象数组，每个对象包含 `link`、`name`（可选）、`message`（可选）和 `breakdowns` 数组
   - `brevisSupplys` / `brevisBorrows`: 对象数组，每个对象包含 `apr`、`link`、`startDate`、`endDate` 和 `name`

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
     - `brevisSupplys` / `brevisBorrows`（空数组时）
     - `aTokenAddress` / `vTokenAddress`（null 时）
     - `supplyApy` / `borrowApy`（undefined 时）

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
- **Token 价格（tokenPrices）**: 来自 Aave markets 数据（`reserve.size.usdPerToken` / `reserve.usdExchangeRate`）为主；Merkl 仅补充 Aave 中不存在的 token。上一轮价格仅在上一轮文件不超过 3× 正常更新周期（3 分钟）时沿用（见上文）。

**Aave SDK（@aave/client）与 token price**：本项目从 SDK 返回的 reserve 里读取 USD 价格（优先 `reserve.size.usdPerToken`，缺失时回退 `reserve.usdExchangeRate`），覆盖所有 reserve underlying token；Merkl 仅补充不在 Aave 中的 token（如部分 reward token），合并时 Aave 覆盖同 key 的 Merkl。

**data 文件夹中的价格**：
- **`data/runtime/aave-formatted-data.json`**：根级别有 **`tokenPrices`** 字段（与 `data`、`_metadata` 并列），即当前 API 返回的同一套价格索引；key 为 `chainId:tokenAddress`（小写）。运行时 JSON（含本文件及 `merkl-opportunity-meta-lite.json`、`merit-campaign-metadata-cache.json`）均使用无缩进（`space: 0`）以减小体积。
- **`data/debug/aave-all-markets-data.json`**：为 Aave SDK 的原始响应（`markets`、`timestamp` 等），其中包含 reserve 的 `usdPerToken` / `usdExchangeRate` 等价格字段（如果上游返回）。

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

# 健康检查
curl http://localhost:3001/health

# 获取 CoinGecko 分类数据
curl http://localhost:3001/api/coingecko-categories

# 获取 CoinGecko FDV 数据
curl http://localhost:3001/api/coingecko-fdv

# 获取利率输入（可选过滤：chainId, asset, marketName）
curl "http://localhost:3001/api/rate-inputs?chainId=1"
```

## 版本信息

- **API 版本**: 2.2
- **文档更新时间**: 2026-03-09
- **最后更新**:
  - 补充端点：`GET /api/health`、`GET /api/coingecko-fdv`、`GET /api/rate-inputs`
  - 基础路径说明更新为完整 API 列表
  - 重构 Merit 数据结构：统一为 `meritSupplys` 和 `meritBorrows` 数组，每个条目包含完整的活动信息（apr, selfApr, link, startDate, endDate, startBlock, endBlock）
  - 统一命名：所有激励字段使用复数形式（meritSupplys, meritBorrows, merklSupplys, merklBorrows, merklHolds）
  - 数据类型优化：APY/APR 值统一为 `number` 类型（百分比数值），不再使用字符串
  - 协议激励改为数值数组：`supplyIncentives` 和 `borrowIncentives` 现在为 `number[]`
  - 移除 Merkl APR 总和字段：`merklSupplyApr`、`merklBorrowApr`、`merklHoldApr` 已移除，数据已包含在对应的 opportunities 中
  - Merkl 数据结构增强：添加 `name` 和 `message` 字段到 opportunity 对象
  - Brevis 数据结构重构：从单个 `brevisSupplyApr`/`brevisBorrowApr` 字段改为 `brevisSupplys`/`brevisBorrows` 数组，支持多个活动
  - 新增 CoinGecko 分类接口：`/api/coingecko-categories` 提供稳定币和以太坊相关代币分类
  - 健康检查接口增强：返回详细的环境配置信息

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
   - 每个 opportunity 包含 `link`、可选的 `name` 和 `message` 字段，以及多个 `breakdowns`（活动详情）
6. **Brevis 数据结构**:
   - 已从单个 APR 字段改为数组结构：`brevisSupplys` 和 `brevisBorrows`
   - 每个条目包含完整的活动信息：`apr`、`link`、`startDate`、`endDate`、`name`
   - 支持多个 Brevis 活动同时存在
7. **数据新鲜度**: 建议根据 `isStale` 和 `lastUpdated` 字段判断数据是否可用
8. **更新机制**: 数据更新是异步的，更新过程中会返回缓存数据
9. **过滤逻辑**: 所有排序和过滤应在客户端完成，API 不提供查询参数
10. **CoinGecko 分类数据**: `/api/coingecko-categories` 接口提供稳定币和以太坊相关代币的分类信息，数据缓存 6 小时
