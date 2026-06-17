# AAV-827 前端 Handoff: AMOUNT 变体 Campaign APR 处理

## 后端已完成

### 核心变更

1. **`resolveCampaignApr` 计算 AMOUNT 变体 APR**：有 rewardTokenPrice 时返回 USD APR（`dsApr × price`）；无 price 时返回 `apr: 0`（前端走 `pointsPerThousandUsd` fallback）
2. **`merklBreakdownUsesPointsIntensityFields` 扩展为 `PRETGE || POINT`**：AMOUNT 变体的 POINT token 也输出 `pointsPerThousandUsd`
3. **去掉 `campaignAprUnavailableReason`**：price 缺失时 `campaignApr = 0`，前端不需要区分 unavailable 原因
4. **`merklPointsFieldsFromBreakdownValue` 对 AMOUNT_PER_AMOUNT 乘以 targetTokenPrice**：`pointsPerThousandUsd = (value / TVL) × 1000 × targetTokenPrice`；AMOUNT_PER_VALUE 不变（TVL 已是 USD）
5. **`campaignApr > 0` 时不输出 `pointsPerThousandUsd`**：避免重复显示
6. **`useTokenRateInMetrics` 改为基于 `rewardTokenPrice`**：有 price → false（USD 路径）；无 price → true（token 路径）。不再基于 `token.type === PRETGE/POINT`
7. **forecastService aprCap**：AMOUNT 变体无 price 时传原始 `rawDsApr`（token-based），使 model `needsAprCap` 检查通过
8. **forecastService TVL 换算**：PER_AMOUNT（AMOUNT_PER_AMOUNT / MAX_PER_AMOUNT）+ 有 targetTokenPrice → `TVL × targetTokenPrice`（换成 USD）
9. **forecastService aprCap 换算**：PER_AMOUNT + 有 targetTokenPrice + 无 rewardTokenPrice → `rawDsApr / targetTokenPrice`（变成 reward/USD/year，和 AMOUNT_PER_VALUE 的 dsApr 维度一致）

### `useTokenRateInMetrics` 影响的位置

| 位置 | 文件 | 影响 |
|---|---|---|
| fetcher price resolve 跳过 | `merkl-api.ts:740,765` | `useTokenRateInMetrics=true` 时跳过 CoinGecko/reserve price resolve |
| fetcher budget skip | `merkl-api.ts:804` | `useTokenRateInMetrics=true` 时允许无 price 的 budget（token 单位） |
| backend extractDailyRewardsRecords | `merklForecastService.ts:280` | `useTokenRateInMetrics=true` → 读 `totalInToken`；false → 读 `total` |
| backend TVL 换算 gate | `merklForecastService.ts:820` | 不再依赖此 flag——TVL 换算由 PER_AMOUNT + targetTokenPrice 决定 |

### AMOUNT 变体的两条路径

后端按 **是否有 rewardTokenPrice** 分两条路径：

#### USD 路径（有 rewardTokenPrice）

所有字段统一为 USD：

| 字段 | AMOUNT_PER_VALUE | AMOUNT_PER_AMOUNT | MAX_PER_AMOUNT |
|---|---|---|---|
| totalBudget | reward × price (USD) | reward × price (USD) | reward × price (USD) |
| aprCap | dsApr × price (USD APR) | dsApr × (price/targetPrice) (USD APR) | dsApr / targetPrice (USD APR) |
| latestTvl | USD（原始） | TVL × targetPrice (USD) | TVL × targetPrice (USD) |
| campaignApr | dsApr × price (USD APR) | dsApr × (price/targetPrice) (USD APR) | dsApr / targetPrice (USD APR) |
| distributedSoFar | USD（读 total） | USD（读 total） | USD（读 total） |

→ 和 VALUE 变体一致，前端不需要特殊处理。

#### Token 路径（无 rewardTokenPrice）

| 字段 | AMOUNT_PER_VALUE | AMOUNT_PER_AMOUNT | MAX_PER_AMOUNT |
|---|---|---|---|
| totalBudget | reward token 数量 | reward token 数量 | reward token 数量 |
| aprCap | dsApr (token/USD/year) | dsApr / targetPrice (token/USD/year) 或 dsApr (token/token/year) | dsApr / targetPrice (USD/token/year→USD/USD/year) 或 dsApr (原始) |
| latestTvl | USD（原始） | TVL × targetPrice (USD) 或 token 数量 | TVL × targetPrice (USD) 或 token 数量 |
| campaignApr | 0 | 0 | 0 |
| distributedSoFar | token 数量（读 totalInToken） | token 数量（读 totalInToken） | token 数量（读 totalInToken） |

→ `campaignApr = 0` + `pointsPerThousandUsd > 0`，前端走 points fallback。

### 维度分析（为什么这样换算是正确的）

**dsApr 的语义**：
- AMOUNT_PER_VALUE：`dsApr = reward_token / USD / year`
- AMOUNT_PER_AMOUNT：`dsApr = reward_token / target_token / year`
- MAX_PER_AMOUNT：`dsApr = USD / target_token / year`（注意分子是 USD）

**PER_AMOUNT + targetTokenPrice 的换算链**：
```
TVL: target_token × targetTokenPrice = USD
aprCap: (reward/target/year) / targetTokenPrice = reward/USD/year  [对 FIX_AMT_PER_AMT]
        (USD/target/year) / targetTokenPrice = USD/USD/year       [对 MAX_PER_AMT]
```
→ 全部统一到 USD 维度，dilution 公式 `TVL × aprCap` 正确。

**PER_AMOUNT 无 targetTokenPrice**（当前仅 FastLane 1 个 case）：
- TVL 保持 target token 数量，aprCap 保持 `dsApr`（token/token/year）
- `TVL × dsApr = target × reward/target/year = reward/year` → 和 totalBudget（reward token 数量）维度自洽
- 但 `latestTvl` 是 token 数量，前端 simulation 中 `latestTvl + inputUsd` 无法直接相加 → **已知边界 case**

### API 响应变化

```typescript
// MerklCampaignBreakdown 现在的结构（campaignAprUnavailableReason 已移除）
interface MerklCampaignBreakdown extends BaseCampaignBreakdown {
  campaignApr: number;  // USD APR (decimal, e.g. 0.035 = 3.5%); 0 = 无收益或无法计算
  pointsPerThousandUsd?: number;  // POINT/PRETGE 类型输出；campaignApr > 0 时不输出
  campaignType?: ForecastCampaignTypeLite;  // +3 AMOUNT 变体枚举值
  // ...
}
```

### AMOUNT 变体的 3 个新 `campaignType` 枚举值

| 枚举值 | Merkl distributionType | 含义 |
|---|---|---|
| `FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE` | FIX_AMT_PER_VALUE | 每 USD 流动性固定 token 数量 |
| `FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT` | FIX_AMT_PER_AMT | 每 token 流动性固定 token 数量 |
| `MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT` | MAX_AMT_PER_AMT | 每 token 流动性最大 token 数量 |

### `pointsPerThousandUsd` 计算逻辑

| distributionType | TVL 含义 | 公式 | priceMultiplier |
|---|---|---|---|
| FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE | USD | `(value / TVL) × 1000` | 1 |
| FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT | target token 数量 | `(value / TVL) × 1000 × targetTokenPrice` | targetTokenPrice |
| MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT | target token 数量 | `(value / TVL) × 1000 × targetTokenPrice` | targetTokenPrice |

无 targetTokenPrice 的 AMOUNT_PER_AMOUNT → `pointsPerThousandUsd = 0`（保守：无法算出正确 USD 强度）。

### 完整数据流

> 完整数据流图、两条路径的字段维度表、维度换算推导见 [`aaveapy-doc/merkl-distribution-types.md` Section 6.7](../../aaveapy-doc/merkl-distribution-types.md)。

以下为前端视角的简化摘要：

```
Merkl API → Fetcher (processMerklData)
                │
                ├─ buildForecastCampaignMetaLiteMap
                │    └─ useTokenRateInMetrics = !(rewardTokenPrice > 0)
                │         有 price → false (USD路径)
                │         无 price → true  (token路径)
                │
                ├─ buildForecastFieldsFromOpportunity
                │    ├─ USD路径: resolve price, totalBudget=USD
                │    └─ token路径: 不resolve, totalBudget=token数量
                │
                ├─ resolveCampaignApr
                │    ├─ AMOUNT + 有price → dsApr × price (USD APR)
                │    ├─ AMOUNT + 无price → apr = 0
                │    └─ VALUE/TARGET → topApr/100
                │
                ├─ merklBreakdownUsesPointsIntensityFields
                │    └─ PRETGE || POINT → 输出 points/intensity 字段
                │         （和 useTokenRateInMetrics 解耦，只控制字段输出）
                │
                ├─ merklPointsFieldsFromBreakdownValue
                │    ├─ campaignApr>0 → suppress pointsPerThousandUsd
                │    └─ AMOUNT_PER_AMOUNT → × targetTokenPrice
                │
                └─ amountVariantBatchDedup: 批量去重 price resolve

                ↓
         Backend (merklForecastService)
                │
                ├─ campaignUsesTokenRateInMetrics = !(rewardTokenPrice > 0)
                │
                ├─ extractDailyRewardsRecords
                │    ├─ token路径 → 读 totalInToken
                │    └─ USD路径 → 读 total
                │
                ├─ aprCap
                │    ├─ VALUE变体 → rawDsApr
                │    ├─ AMOUNT + 有rewardTokenPrice → 换算USD APR
                │    ├─ AMOUNT + 无rewardTokenPrice + 有targetTokenPrice → dsApr/targetTokenPrice
                │    └─ AMOUNT + 无rewardTokenPrice + 无targetTokenPrice → rawDsApr
                │
                ├─ TVL
                │    ├─ PER_AMOUNT + 有targetTokenPrice → TVL×targetTokenPrice (USD)
                │    └─ 其他 → 原始TVL
                │
                └─ buildForecastState → dilution公式

                ↓
         前端 (AAV-898)
                ├─ campaignApr > 0 → 显示 USD APR
                ├─ campaignApr = 0 + pointsPerThousandUsd > 0 → 走 points fallback
                └─ forecastWithTVL: 按四大类型分 (DUTCH/FIX/MAX/TTA)
```

## 前端需要做的

### 1. `forecastWithTVL` 按 campaignType 四大类型分

**文件**: `src/lib/merklForecast.ts`

当前 `forecastWithTVL` 只识别 `MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE`、`FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE`、`DUTCH_AUCTION`。需要扩展为识别所有 6 种类型（3 个 VALUE + 3 个 AMOUNT），按四大类处理：

| 大类 | campaignType | 处理方式 |
|---|---|---|
| DUTCH | DUTCH_AUCTION | 现有逻辑不变 |
| FIX_VALUE | FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE | 现有逻辑不变 |
| FIX_AMOUNT | FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE, FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT | 和 FIX_VALUE 相同逻辑（后端已统一到 USD 维度） |
| MAX | MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE, MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT | 现有 MAX 逻辑（后端已统一到 USD 维度） |

后端已把 AMOUNT 变体的 forecast 字段统一到 USD 维度（有 price 时）或 token 维度（无 price 时），所以前端 `forecastWithTVL` 可以用和 VALUE 变体相同的逻辑处理 AMOUNT 变体。

### 2. `normalizeUsdUnit` 区分有/无 price

**文件**: `src/lib/merklForecast.ts`

当前 `normalizeUsdUnit` 对 points campaign 做 `convertMerklPointsAmountToUsd(× rate)` 换算。

需要改为：
- 有 rewardTokenPrice 的 campaign → 透传 USD 值（后端已换算）
- 无 rewardTokenPrice 的 campaign → 透传 token 数量，不做 `× rate` 换算

判断方式：检查 `campaignApr > 0`（有 price → 有 USD APR）或直接检查 breakdown 中的 `token.price`。

### 3. `latestTvl` 不应乘 rate

**文件**: `src/lib/merklForecast.ts`

后端返回的 `latestTvl` 在 PER_AMOUNT + 有 targetTokenPrice 时已换算为 USD。前端不应再乘 `pointToUsdRate`。

### 4. `TYDRO_POINT_TO_USD_RATE` 只对 Ink 生效

**文件**: `src/lib/tydro.ts`

- TydroInkPoints（Ink campaign）→ rate 由 InkAprCalculator 的 FDV slider 控制，默认 1.0
- 其他 points token（AMOUNT 变体）→ rate 默认 0（避免虚假 APR）

Ink 的 TydroInkPoints 没有 Merkl snapshot price，`useTokenRateInMetrics = true`（token 路径）。Ink 是 DUTCH_AUCTION，不是 AMOUNT 变体，`campaignApr` 来自 `topApr/100`。前端仍走 `pointsPerThousandUsd` + `TYDRO_POINT_TO_USD_RATE` 路径，行为不变。其他 AMOUNT 变体的 points token 没有 price → rate 默认 0 → 显示 %。

### 5. 类型定义不需要更新

前端 `MerklCampaignBreakdown` 类型中从未添加过 `campaignAprUnavailableReason`，无需删除。

### 6. 已知边界 case：PER_AMOUNT 无 targetTokenPrice

当前仅 FastLane 1 个 case（AMOUNT_PER_AMOUNT，tokens 数组为空）。后端不换算 TVL，`latestTvl` 保持 target token 数量。前端 `forecastBreakdownApr` 中 `hypotheticalTvl = latestTvl + inputUsd` 无法直接相加（token 数量 + USD）。建议显示时标注或跳过 simulation。

## 验证数据

部署后检查以下 campaign 的 Merkl breakdown：

| 协议 | Token | token.type | campaignType | 预期 |
|---|---|---|---|---|
| IPOR Fusion | ipor-fusion-points-s2 | POINT | FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE | `campaignApr = 0`，`pointsPerThousandUsd > 0` |
| Gravity | Gravity Points | POINT | FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE 或 _AMOUNT | `campaignApr = 0`，`pointsPerThousandUsd > 0` |
| Lendle | LendPoints | POINT | FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE | `campaignApr = 0`，`pointsPerThousandUsd > 0` |
| Whop | Whop USD | TOKEN | MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT | `campaignApr > 0`（有 price） |
| pTMX | pTMX | PRETGE | FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE | `campaignApr > 0`（有 price） |
| Ink | TydroInkPoints | PRETGE | DUTCH_AUCTION | 行为不变（有 snapshot price，走 USD 路径） |

## 已解决的后端问题

### ✅ forecastService `needsAprCap` 与 forecastModel `needsAprCap` 不一致

已修复：`merklForecastService.ts` 的 `needsAprCap` 已补上 AMOUNT 变体的 3 种类型，且 AMOUNT 变体无 price 时传 `rawDsApr` 作为 aprCap（不再返回 null）。

### ✅ `normalizeMerklCampaignTotalBudget` 双重换算风险

已解决：`useTokenRateInMetrics` 改为基于 `rewardTokenPrice` 后，无 price 的 campaign 走 token 路径 → `normalizeMerklCampaignTotalBudget` 不乘 price（price 为 null）→ 不会双重换算。有 price 的 campaign 走 USD 路径 → 乘 price 是正确行为。

## 待开 Issue：CoinGecko fallback 扩展

当前 CoinGecko price resolve 只在 `buildForecastFieldsFromOpportunity` 中执行（forecast budget 字段），不在 `resolveCampaignApr` 中执行。如果将来出现 TOKEN 类型的 AMOUNT 变体且无 Merkl snapshot price，`campaignApr` 会是 0，前端无法显示 APR 或做 simulation。建议另开 issue 在 `resolveCampaignApr` 中也加 CoinGecko fallback。

同理，PER_AMOUNT 的 targetTokenPrice 也可能缺失 CoinGecko fallback。当前 Pendle PT token 缺 rewardTokenPrice（3 个 AMOUNT_PER_VALUE case），如果 CoinGecko 有价格可以补充。

这不影响当前架构，可以后续迭代。

## 相关

- AAV-827: 主 issue
- PRD: AAV-876, AAV-896
- AAV-898: 前端修改
- AAV-900: Pendle PT token targetTokenPrice
- Backend commit `9ef5779`: feat(merkl): resolve AMOUNT variant USD APR
- Backend commit `266dd7b`: remove campaignAprUnavailableReason + extend points intensity to POINT type
- Backend commit `f85aec3`: fix snapshotPrice in batch price resolve
- Backend commit `57336ea`: multiply pointsPerThousandUsd by targetTokenPrice for AMOUNT_PER_AMOUNT
- Backend commit `6bd31ca`: sync needsAprCap + suppress pointsPerThousandUsd when campaignApr > 0
