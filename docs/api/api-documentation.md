# API 接口文档

## 概述

本文档描述了 Aave 市场数据服务的 API 接口和数据格式。服务提供 Aave V3 协议的市场数据，包括基础 APY、协议激励、Merit APR、Merkl APR 和 Brevis APR 等激励信息。

## 基础信息

- **服务地址**: `http://localhost:3001` (开发环境)
- **API 基础路径**:
  - `/api/markets` - 市场数据
  - `/api/coingecko-categories` - CoinGecko 分类数据
  - `/api/coingecko-fdv` - CoinGecko FDV 数据
  - `/api/meta/side-data` - 低频侧数据聚合（categories + fdv）
  - `/api/campaigns/forecast-states` - Merkl 活动预测状态（批量）
  - `/api/rate-inputs` - 利率输入/储备参数
  - `/health`、`/api/health` - 健康检查
- **数据格式**: JSON
- **字符编码**: UTF-8
- **端点总数**: **8 个**（8 条 URL；若将 `GET /health` 与 `GET /api/health` 视为同一逻辑则共 7 个逻辑端点）

## 数据模型

### FormattedReserveData

市场储备数据的完整结构，包含所有激励信息。

```typescript
interface FormattedReserveData {
  // 基础信息
  reserveId: string;                     // 储备 ID（唯一标识符）
  marketName: string;                    // 市场名称，如 "AaveV3Arbitrum"
  chainName: string;                     // 链名称，如 "Arbitrum"
  chainId: number;                       // 链 ID，如 42161
  tokenName: string;                     // 代币名称，如 "Aave Token"
  tokenSymbol: string;                   // 代币符号，如 "AAVE"
  tokenAddress: string;                  // 底层代币地址
  aTokenAddress: string | null;          // aToken 地址
  vTokenAddress: string | null;          // variableDebtToken 地址
  
  // 价格与规模（单位已说明）
  tokenPrice?: number;                   // 【单位: USD】每个 token 的美元价格
  reserveSizeUsd?: number;                // 【单位: USD】市场总供应量（TVL = total supply），美元计价
  utilizationPct?: number;               // 【单位: 百分比 0-100】资金利用率，如 45.5 表示 45.5%
  
  // 基础 APY 与禁用状态（单位: 百分比）
  supplyApy?: number;                    // 【单位: 百分比】Supply APY，如 2.07 表示 2.07%
  supplyDisabled?: boolean;              // 供应是否被禁用（仅当 true 时出现），原因：isFrozen、isPaused 或 supplyCap=1
  supplyCapUsd?: number;                 // 【单位: USD】供应上限金额
  borrowApy?: number;                    // 【单位: 百分比】Borrow APY，如 3.97 表示 3.97%（即使禁用也返回真实值）
  borrowDisabled?: boolean;              // 借贷是否被禁用（仅当 true 时出现），原因：borrowingState=DISABLED 或 borrowCap=1
  borrowCapUsd?: number;                 // 【单位: USD】借贷上限金额，与 supplyCapUsd 对称
  
  // 协议激励（来自 Aave 协议，单位: 百分比）
  supplyIncentives?: number[];           // 【单位: 百分比数组】Protocol supply incentives
  borrowIncentives?: number[];           // 【单位: 百分比数组】Protocol borrow incentives
  
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

**描述**: 获取 markets 快照（`markets-v2`），返回 `snapshot + reserves`。其中 `reserves` 保留原有全量 reserve 字段（包括 `aTokenAddress`、`vTokenAddress`、各类激励字段），并新增 `tokenPrice` / `reserveSizeUsd` / `utilizationPct` 以支持前端展示。如果数据超过 1 分钟未更新，会自动触发后台更新。若更新持续失败且快照陈旧时间超过硬上限（默认 5 分钟），接口会返回 `503`，避免长期返回过旧数据。

**请求参数**: 无

**响应格式**:

```typescript
interface MarketsResponse {
  snapshot: {
    lastUpdated: string;               // 最后更新时间（ISO 8601）
    version: 'markets-v2';
    staleTimeMs: number;               // 认为数据过期的阈值（毫秒），默认 60 秒
  };
  reserves: MarketWithSpread[];        // 保留原全量字段 + 新增展示字段
}
```

**Token 价格返回策略**：

- 每条 `reserves` 记录新增 `tokenPrice`（优先用于前端渲染，避免额外 join）
- Merkl reward token 价格当前**不在 `/api/markets` 输出**
- 若 reward token 恰好是某个 reserve 的 `aTokenAddress`，其价格按 underlying token 对待，不单独输出
- **来源字段**：`aave` 来源的价格来自 Aave markets 数据里的 `reserve.size.usdPerToken`（若缺失则回退 `reserve.usdExchangeRate`）。
- **缺省行为**：极少数 token 若本轮 Aave/Merkl 均未返回价格，则会沿用上一轮文件中该 token 的价格**仅当**上一轮文件的 `_metadata.timestamp` 在 3 倍正常更新周期内（3× backend stale 阈值，即 3 分钟）；超过则不沿用，避免长期保留已不再出现的 token 的过期价格。

**市场筛选列表**：请从 `reserves` 中按 `{ marketName, chainName }` 去重推导，不要再引入额外市场列表接口。

**响应示例**:

```json
{
  "snapshot": {
    "lastUpdated": "2026-01-13T11:00:06.895Z",
    "version": "markets-v2"
  },
  "reserves": [
    {
      "reserveId": "AaveV3Ethereum:1:0xbe9895146f7af43049ca1c1ae358b0541ea49704",
      "marketName": "AaveV3Ethereum",
      "chainName": "Ethereum",
      "chainId": 1,
      "tokenName": "Coinbase Wrapped Staked ETH",
      "tokenSymbol": "cbETH",
      "tokenAddress": "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704",
      "aTokenAddress": "0x977b6fc5dE62598B08C85AC8Cf2b745874E8b78c",
      "vTokenAddress": "0x0c91bcA95b5FE69164cE583A2ec9429A569798Ed",
      "supplyApy": 0.183795381577371,
      "tokenPrice": 3942.52,
      "reserveSizeUsd": 1083255123.44,
      "utilizationPct": 61.08
    }
  ]
}
```

**状态码**:
- `200`: 成功
- `503`: 数据快照超过硬过期上限（默认 5 分钟），服务拒绝返回过旧数据（`errorCode = "MARKETS_SNAPSHOT_HARD_STALE"`）
- `500`: 服务器错误

**注意事项**:
- 所有排序和过滤逻辑应在客户端处理
- 如果数据过期，会自动触发后台更新；在硬过期上限内可继续返回缓存
- 一旦快照年龄超过硬过期上限（默认 5 分钟），将返回 `503`（不再无限返回旧缓存）
- `tokenPrice` 已直接放在 `reserves` 行内，前端无需再做额外 price join

---

### `/api/markets` 最终字段契约（前端）

当前前端仅需依赖以下稳定字段：

- `snapshot.lastUpdated`
- `reserves[].reserveId`
- `reserves[].marketName`
- `reserves[].chainName`
- `reserves[].chainId`
- `reserves[].tokenName`
- `reserves[].tokenSymbol`
- `reserves[].tokenAddress`
- `reserves[].tokenPrice`
- `reserves[].reserveSizeUsd`
- `reserves[].utilizationPct`
- 以及原有激励字段（`supplyIncentives` / `borrowIncentives` / `merit*` / `merkl*` / `brevis*`）

不再依赖：

- 根级 `tokenPrices`
- 行内 `tokenPriceKey`

---

### 2. 批量获取 Merkl Forecast States

**端点**: `GET /api/campaigns/forecast-states`

**请求参数**:
- `ids` (可选): 逗号分隔 campaignId 列表；省略时默认返回当前 markets 中全部 campaign 的状态。

**`ids` 获取方式**:
- 方式 1（推荐）：先请求 `GET /api/markets`，从 `reserves[].merklSupplys[]/merklBorrows[]/merklHolds[]` 的 `breakdowns[].campaignId` 提取并去重。
- 方式 2：直接使用你已知的 campaignId（例如来自业务配置或历史记录），按逗号拼接传入 `ids`。

示例（从 `/api/markets` 自动提取 ids）：

```bash
IDS=$(curl -s "http://localhost:3001/api/markets" | jq -r '
  .reserves[]
  | (.merklSupplys // []) + (.merklBorrows // []) + (.merklHolds // [])
  | .[]
  | (.breakdowns // [])[].campaignId
' | sort -u | paste -sd, -)

curl -s "http://localhost:3001/api/campaigns/forecast-states?ids=${IDS}" | jq
```

示例（手动指定 ids）：

```bash
curl -s "http://localhost:3001/api/campaigns/forecast-states?ids=campaignA,campaignB,campaignC" | jq
```

**响应格式**:

```json
{
  "requested": 23,
  "items": [],
  "errors": [],
  "staleTimeMs": 600000
}
```

其中：
- `items` 为成功计算的 campaign 状态数组（字段同单个接口）。
- `errors` 为失败项数组：`{ campaignId, status, message }`。
- `staleTimeMs` 为 Merkl forecast 结果缓存 TTL（毫秒），默认 10 分钟（与 `merklMetricsMin` 对齐，可通过环境变量 `MERKL_FORECAST_RESULT_CACHE_TTL_MS` 覆盖）。

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
  "fetchedAt": "2026-03-09T12:00:00.000Z",
  "staleTimeMs": 300000
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
  "uniqueSymbolsEth": ["WETH", "STETH", "RETH", "CBETH", ...],
  "fetchedAt": "2026-03-09T12:00:00.000Z",
  "staleTimeMs": 21600000
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
      "tokenAddress": "0x...",
      "decimals": 18,
      "deficit": "0",
      "availableLiquidity": "4512942554869044630386380",
      "totalScaledVariableDebt": "117694766706416553160100",
      "variableBorrowIndex": "1005096238292405352590901947",
      "reserveFactor": "2000",
      "variableRateSlope1": "90000000000000000000000000",
      "variableRateSlope2": "3000000000000000000000000000",
      "baseVariableBorrowRate": "0",
      "optimalUsageRate": "450000000000000000000000000"
    }
  ],
  "lastUpdated": "2026-03-09T12:00:00.000Z",
  "staleTimeMs": 60000,
  "sources": {
    "subgraphChains": [137, 43114],
    "onchainChains": [1, 10, 42161],
    "subgraphMissingChains": [],
    "unhealthyRpcEndpoints": []
  }
}
```

**响应字段说明**:

| 字段 | 类型 | 单位 | 说明 |
|------|------|------|------|
| `chainId` | number | - | 链 ID |
| `marketName` | string | - | 市场名称，如 "AaveV3Ethereum" |
| `tokenAddress` | string | - | 底层 token 地址（小写） |
| `decimals` | number | - | token 精度 |
| `deficit` | string | **token 原始单位** | 该储备的 deficit（坏账缺口），用于 utilization 分母口径修正 |
| `availableLiquidity` | string | **token 原始单位** | 可用流动性（除以 `10^decimals` 得到 token 数量） |
| `totalScaledVariableDebt` | string | **scaled token** | 缩放后的可变债务（需乘 `variableBorrowIndex / RAY`） |
| `variableBorrowIndex` | string | **RAY (10^27)** | 可变借款累积指数 |
| `reserveFactor` | string | **BPS (10^4)** | 储备金率（2000 = 20%） |
| `variableRateSlope1` | string | **RAY (10^27)** | 最优使用率以下的利率斜率 |
| `variableRateSlope2` | string | **RAY (10^27)** | 最优使用率以上的利率斜率 |
| `baseVariableBorrowRate` | string | **RAY (10^27)** | 基础可变借款利率 |
| `optimalUsageRate` | string | **RAY (10^27)** | 最优使用率（0.45 * 10^27 = 45%） |

> **注意**：所有大数值字段均为字符串类型（避免 JavaScript 精度丢失），前端需使用 `BigInt` 处理。详细单位转换说明见下方「数值单位说明」章节。
>
> `deficit` 来源优先级：
> - On-chain 路径：`pool.getReserveDeficit(asset)`（最高优先级）
> - Aave API fallback：当前不提供 deficit，返回 `0`
> - Subgraph fallback：当前不提供 deficit，返回 `0`

**状态码**: `200` 成功，`400` 参数无效（如 `chainId` 非正整数），`500` 服务端错误

---

### 7. 获取侧数据聚合（Meta Side Data）

**端点**: `GET /api/meta/side-data`

**描述**: 聚合返回低频侧数据，用于前端一次性获取 CoinGecko 分类、FDV 快照和 Merkl forecast 状态。内部组合了：

- `GET /api/coingecko-categories` 的最新快照元信息（6h TTL）
- `GET /api/coingecko-fdv` 的最新快照元信息（5m TTL）
- `GET /api/campaigns/forecast-states` 的全量 forecast 数据（10m TTL）

不会触发市场数据刷新，仅依赖各自缓存与 TTL。

**请求参数**: 无

**响应格式**:

```json
{
  "generatedAt": "2026-03-09T12:00:00.000Z",
  "partial": false,
  "categories": {
    "uniqueSymbolsStablecoins": ["USDT", "USDC", "DAI"],
    "uniqueSymbolsEth": ["WETH", "STETH", "RETH"],
    "fetchedAt": "2026-03-09T12:00:00.000Z",
    "staleTimeMs": 21600000
  },
  "fdv": {
    "items": [
      {
        "id": "binancecoin",
        "symbol": "BNB",
        "name": "BNB",
        "fdvUsd": 123456789012,
        "source": "coinmarketcap"
      }
    ],
    "fetchedAt": "2026-03-09T12:00:00.000Z",
    "staleTimeMs": 300000
  },
  "forecast": {
    "items": [
      {
        "campaignId": "0x...",
        "campaignType": "DUTCH_AUCTION",
        "plannedDaily": 1000,
        "requiredDaily": 1200,
        "aprCap": null,
        "totalBudget": 100000,
        "distributedSoFar": 45000,
        "latestTvl": 5000000,
        "endTimestamp": 1710000000
      }
    ],
    "errors": [],
    "staleTimeMs": 600000
  },
  "errors": {
    "categories": "optional error message when categories snapshot fails",
    "fdv": "optional error message when fdv snapshot fails",
    "forecast": "optional error message when forecast snapshot fails"
  }
}
```

字段说明：

- `generatedAt`: 当前 meta 响应生成时间（ISO 8601）。
- `partial`: 当 categories、fdv、forecast 其中之一失败时为 `true`。
- `categories`: 当分类快照可用时存在，结构同 `GET /api/coingecko-categories`，附加：
  - `fetchedAt`: 分类数据上次刷新时间。
  - `staleTimeMs`: 分类缓存 TTL（毫秒），默认 6 小时。
- `fdv`: 当 FDV 快照可用时存在，结构同 `GET /api/coingecko-fdv`，附加：
  - `fetchedAt`: FDV 数据上次刷新时间。
  - `staleTimeMs`: FDV 缓存 TTL（毫秒），默认 5 分钟。
- `forecast`: 当 forecast 快照可用时存在，结构：
  - `items`: forecast 状态数组，字段同 `GET /api/campaigns/forecast-states`。
  - `errors`: 部分 campaign 计算失败的错误数组（`{ campaignId, message }`）。
  - `staleTimeMs`: forecast 缓存 TTL（毫秒），默认 10 分钟。
- `errors`: 可选对象，键为 `categories`/`fdv`/`forecast`，值为对应子任务整体失败时的错误信息。

**状态码**:

- `200`: 至少有一块数据成功（`partial` 可能为 `true`）。
- `500`: categories、fdv、forecast 均失败（无可用侧数据）。

---

## 数据说明

### 字段类型说明

1. **APY/APR 格式**:
   - `supplyApy`: 数值格式的百分比（如 `2.07` 表示 2.07%），如果为 `undefined` 则在 JSON 中不出现
   - `borrowApy`: 数值格式的百分比（如 `3.97` 表示 3.97%），即使借贷被禁用也会返回真实值
   - `borrowDisabled`: 布尔值，仅当借贷被禁用时出现且为 `true`（节约带宽）
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
     - `borrowDisabled`（仅当 `true` 时出现）
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
     - `supplyApy`（undefined 时）
     - `borrowDisabled`（`false` 或 undefined 时，即借贷启用时不出现）

3. **Merit 数据结构说明**:
   - `meritSupplys` 和 `meritBorrows` 是数组，每个元素代表一个 Merit 激励活动
   - 如果同一个活动有 self 和非 self 版本，它们会合并到同一条目中：
     - `apr` 字段存储非 self 版本的 APR
     - `selfApr` 字段存储 self 版本的 APR（如果存在）
   - `requiredBorrowTokens` 和 `requiredSupplyTokens` 用于表示条件激励：
     - 如果 `meritSupplys` 条目包含 `requiredBorrowTokens`，表示需要先 borrow 指定的 token 才能获得该 supply APR
     - 如果 `meritBorrows` 条目包含 `requiredSupplyTokens`，表示需要先 supply 指定的 token 才能获得该 borrow APR
     - `'multiple'` 表示任意 token 都可以满足条件

4. **供应禁用状态 (`supplyDisabled`)**:
   - Aave 协议有三种方式禁用供应：
     1. 储备冻结：`isFrozen === true`
     2. 储备暂停：`isPaused === true`
     3. Cap 设为 1：`supplyCap === 1`（实际上无法供应）
   - 当上述任一条件满足时，`supplyDisabled: true` 会出现在响应中
   - `supplyCapUsd` 始终返回（如果有值），表示供应上限的美元金额
   - 前端处理建议：
     ```typescript
     // 判断是否可供应
     const canSupply = !reserve.supplyDisabled;
     
     // 显示供应上限
     if (reserve.supplyCapUsd) {
       console.log(`Supply cap: $${reserve.supplyCapUsd.toLocaleString()}`);
     }
     ```

5. **借贷禁用状态 (`borrowDisabled`)**:
   - Aave 协议有两种方式禁用借贷：
     1. 直接禁用：`borrowingState === "DISABLED"`
     2. Cap 设为 1：`borrowCap === 1`（实际上无法借贷）
   - 当上述任一条件满足时，`borrowDisabled: true` 会出现在响应中
   - 即使借贷被禁用，`borrowApy` 仍返回真实的利率值（供展示或分析用途）
   - 前端处理建议：
     ```typescript
     // 判断是否可借贷
     const canBorrow = !reserve.borrowDisabled;
     
     // 显示借贷利率（可加禁用标记）
     if (reserve.borrowDisabled) {
       displayRate(reserve.borrowApy, { disabled: true });
     } else {
       displayRate(reserve.borrowApy);
     }
     ```

6. **数值单位说明**:

   #### `/api/markets` 响应字段单位

   | 字段 | 单位 | 说明 |
   |------|------|------|
   | `tokenPrice` | USD | 每个 token 的美元价格 |
   | `reserveSizeUsd` | USD | 市场总供应量（TVL），美元计价 |
   | `supplyCapUsd` | USD | 供应上限，美元计价 |
   | `utilizationPct` | 百分比 (0-100) | 资金利用率，如 `45.5` 表示 45.5% |
   | `supplyApy` | 百分比 | 供应 APY，如 `2.07` 表示 2.07% |
   | `borrowApy` | 百分比 | 借贷 APY，如 `3.97` 表示 3.97% |
   | `supplyIncentives` | 百分比数组 | 协议供应激励 APR |
   | `borrowIncentives` | 百分比数组 | 协议借贷激励 APR |
   | `meritSupplys[].apr` | 百分比 | Merit 供应 APR |
   | `merklSupplys[].breakdowns[].campaignApr` | 百分比 | Merkl campaign APR |

   #### `/api/rate-inputs` 响应字段单位

   **重要**：rate-inputs 返回的是链上原始数据，需要前端自行转换。

   | 字段 | 原始单位 | 转换说明 |
   |------|----------|----------|
   | `decimals` | 整数 | token 精度（用于其他字段的换算） |
   | `deficit` | **token 原始单位** (string) | 坏账缺口；utilization 分母口径需要加上该值 |
   | `availableLiquidity` | **token 原始单位** (string) | 可用流动性。换算：`BigInt(value) / 10^decimals` 得到 token 数量 |
   | `totalScaledVariableDebt` | **scaled token 单位** (string) | 缩放后的可变利率债务。需乘以 `variableBorrowIndex` 并除以 RAY 得到实际债务 |
   | `variableBorrowIndex` | **RAY** (27 decimals) | 可变借款指数。换算：`BigInt(value) / 10^27` 得到倍数 |
   | `reserveFactor` | **BPS** (4 decimals) | 储备金率。换算：`value / 10000` 得到小数（如 2000 → 0.20 = 20%） |
   | `variableRateSlope1` | **RAY** (27 decimals) | 利率曲线斜率 1。换算：`BigInt(value) / 10^27` 得到小数 |
   | `variableRateSlope2` | **RAY** (27 decimals) | 利率曲线斜率 2。换算同上 |
   | `baseVariableBorrowRate` | **RAY** (27 decimals) | 基础可变借款利率。换算同上 |
   | `optimalUsageRate` | **RAY** (27 decimals) | 最优使用率。换算：`BigInt(value) / 10^27`（如 450000...000 → 0.45 = 45%） |

   #### 常用单位定义

   | 单位名称 | 精度 | 说明 |
   |----------|------|------|
   | **RAY** | 27 decimals | Aave 协议标准精度单位，`1 RAY = 10^27` |
   | **BPS** | 4 decimals | 基点（Basis Points），`10000 BPS = 100%` |
   | **WAD** | 18 decimals | 常见 ERC20 精度，`1 WAD = 10^18` |

   #### 前端转换示例

   ```typescript
   const RAY = BigInt(10) ** BigInt(27);
   const BPS_DIVISOR = 10000;

   // 转换 availableLiquidity 为 token 数量
   function toTokenAmount(raw: string, decimals: number): number {
     return Number(BigInt(raw)) / Math.pow(10, decimals);
   }

   // 转换 RAY 单位为小数
   function fromRay(raw: string): number {
     return Number(BigInt(raw)) / Number(RAY);
   }

   // 转换 BPS 为小数
   function fromBps(raw: string): number {
     return Number(raw) / BPS_DIVISOR;
   }

   // 计算实际可变债务
   function getActualVariableDebt(
     scaledDebt: string,
     borrowIndex: string,
     decimals: number
   ): number {
     const scaled = BigInt(scaledDebt);
     const index = BigInt(borrowIndex);
     const actualRaw = (scaled * index) / RAY;
     return Number(actualRaw) / Math.pow(10, decimals);
   }
   ```

### 数据来源

- **基础 APY**: 来自 Aave 协议 API
- **协议激励**: 来自 Aave 协议的 `reserve.incentives`
- **Merit APR**: 来自 `https://apps.aavechan.com/api/merit/aprs`
- **Merkl APR**: 来自 `https://api.merkl.xyz/v4/opportunities`
- **Brevis APR**: 来自 Brevis Network Linea Surge API
- **Token 价格（/api/markets）**: 当前仅在 `reserves[].tokenPrice` 行内返回，不再输出 Merkl reward token 的单独价格补充。

**Aave SDK（@aave/client）与 token price**：本项目从 SDK 返回的 reserve 里读取 USD 价格（优先 `reserve.size.usdPerToken`，缺失时回退 `reserve.usdExchangeRate`），用于 `reserves[].tokenPrice`。

**data 文件夹中的价格**：
- **`data/runtime/aave-formatted-data.json`**：当前以 `data + _metadata` 为主，不再依赖根级 token price 补充索引供 `/api/markets` 使用。
- **`data/debug/aave-all-markets-data.json`**：为 Aave SDK 的原始响应（`markets`、`timestamp` 等），其中包含 reserve 的 `usdPerToken` / `usdExchangeRate` 等价格字段（如果上游返回）。

### 数据更新机制

- **仅 `GET /api/markets`** 会触发市场数据新鲜度检查：若数据超过 1 分钟未更新，该请求会触发后台刷新（带并发锁），其他端点不触发市场数据刷新。
- 其他端点（`/api/coingecko-*`、`/api/campaigns/forecast-states`、`/api/rate-inputs`）使用各自缓存与 TTL。
- 使用锁机制防止并发更新；更新进行中时，请求会等待约 1 秒再返回。
- `/api/markets` 返回 `snapshot + reserves`；`isStale` / `updateInProgress` 不在该接口响应中。

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
console.log(data.snapshot.lastUpdated); // 最后更新时间
console.log(data.reserves.length); // reserve 数量
console.log(data.reserves[0]?.tokenPrice); // 行内 token 价格
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

- **API 版本**: 3.0
- **文档更新时间**: 2026-03-13
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
  - **2026-03-11**：明确仅 `GET /api/markets` 触发市场数据新鲜度检查与自动刷新；其他端点使用各自缓存/TTL
  - **2026-03-11（breaking）**：`GET /api/markets` 响应结构切换为 `snapshot + reserves`（`markets-v2`）
  - **2026-03-11**：`reserves` 保留原全量字段，并新增 `tokenPrice`、`reserveSizeUsd`、`utilizationPct`
  - **2026-03-11**：Merkl reward token 价格先不在 `/api/markets` 输出；若 reward token 为某 reserve 的 aToken，也不单独输出
  - **2026-03-13**：为 `/api/markets`、`/api/rate-inputs`、`/api/coingecko-*`、`/api/campaigns/forecast-states` 增加 `staleTimeMs` 字段说明
  - **2026-03-13**：新增 `/api/meta/side-data` 端点文档，并描述 categories/fdv 子快照的 `fetchedAt` 与 `staleTimeMs`
  - **2026-03-13（breaking）**：`/api/markets` 字段 `marketSizeUsd` 更名为 `reserveSizeUsd`
  - **2026-03-13（breaking）**：`/api/rate-inputs` 字段从 `reserveSize` 调整为 `deficit`

## 注意事项

1. **数据格式一致性**: 
   - 所有 APY/APR 值都使用 `number` 类型（百分比数值），如 `2.07` 表示 2.07%
   - 不再使用字符串格式的百分比值
2. **可选字段**: 可选字段在 JSON 中可能不存在，访问前应检查字段是否存在（使用 `'field' in obj` 或 `obj.field !== undefined`）
3. **空值处理**: 
   - `null` 和 `undefined` 在 JSON 中都不会出现（通过 replacer 函数处理）
   - 空数组会被转换为 `undefined` 并省略
   - 数值 `0` 是有效值，会保留在 JSON 中
4. **`/api/markets` 字段变化（breaking）**:
   - 结构：`snapshot + reserves`
   - `reserves` 中保留原全量字段，并新增 `tokenPrice`、`reserveSizeUsd`、`utilizationPct`、`reserveId`
   - `rate-inputs` 新增 `deficit`，前端在 utilization 分母中应与 `availableLiquidity + totalVariableDebt` 合并使用
5. **数据新鲜度**: 建议根据 `snapshot.lastUpdated` 字段判断数据是否可用
6. **更新机制**: 数据更新是异步的，更新过程中会返回缓存数据
7. **过滤逻辑**: 所有排序和过滤应在客户端完成，API 不提供查询参数
8. **CoinGecko 分类数据**: `/api/coingecko-categories` 接口提供稳定币和以太坊相关代币的分类信息，数据缓存 6 小时
