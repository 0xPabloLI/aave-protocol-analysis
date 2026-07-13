# AAV-827 Backend Handoff: AMOUNT 变体 Campaign APR 修复

> **SUPERSEDED** — 此文档为早期草稿，`campaignAprUnavailableReason` 方案已被废弃。
> 最新前端 handoff 见 [aav-827-frontend-handoff.md](./aav-827-frontend-handoff.md)。

## Priority
高 — 后端返回错误数据会直接导致前端显示误导性 APR

## 当前问题

### Fetcher 端 `resolveCampaignApr` 需要回退/重写

文件：`packages/aave-fetcher/src/merkl-api.ts`

当前实现（需修改）：
```typescript
// 用 distributionType 包含 _AMOUNT_ 判断，返回 distributionSettings.apr
// 问题：返回值是 token 利率（如 18.25 或 3650），不是 USD APR
// 前端会把它当百分比显示，用户看到 1825% 或 365000%
export const resolveCampaignApr = (campaign: any, distributionType?: string): number => {
  // ... AMOUNT fallback to distributionSettings.apr
};
```

测试文件：`packages/aave-fetcher/tests/resolveCampaignApr.test.ts`（8 个测试，需随代码一起更新）

### 两处调用点

1. `merkl-api.ts:~1129` — `opp.campaigns.forEach` 中构建 `campaignDetailsCache`
2. `merkl-api.ts:~924` — `fetchMerklCampaignDetails` 函数

## 需要实现的内容

### 1. Token Price 获取逻辑

在 fetcher 或 backend 中（需确定位置）：

```
1. 检查 campaign.rewardToken.price（Merkl API 已有）
2. 若无，调 CoinGecko API 获取
3. 若仍无，标记为 "no price available"
```

### 2. USD APR 计算

```
VALUE 变体:
  usdApr = campaign.apr / 100  （现有逻辑不变）

AMOUNT_PER_VALUE:
  tokenApr = distributionSettings.apr  （单位: tokens/USD/year）
  usdApr = tokenApr × rewardTokenPrice  （→ USD/USD/year = 百分比）
  例: 18.25 × price → 如果 price = 0.001 → usdApr = 0.01825 = 1.825%

AMOUNT_PER_AMOUNT:
  tokenRatio = distributionSettings.apr  （单位: tokens/token/year）
  usdApr = tokenRatio × rewardTokenPrice / targetTokenPrice
  需要两个 token 的价格，任一缺失则无法计算
```

### 3. 返回结构

在 breakdown 或 campaign details 中增加：

```typescript
{
  campaignApr: number;           // decimal USD APR (如 0.035 = 3.5%)
  campaignAprUnavailable?: boolean;  // 无法计算时为 true
  campaignAprUnavailableReason?: 'NO_REWARD_TOKEN_PRICE' | 'NO_TARGET_TOKEN_PRICE';
}
```

### 4. AMOUNT_PER_AMOUNT 的降级处理

- `tvlRecords[].total = 0` 且 `totalInToken = None`
- forecast 无法计算（tvl = 0）
- 默认按"无 TVL"处理，AAV-870 另解
- `campaignAprUnavailable = true`

## 验证数据

| 变体 | Campaign ID | campaign.apr | ds.apr | rewardToken.price | 期望 campaignApr |
|---|---|---|---|---|---|
| VALUE | 14885251677142679755 | 6 | 0.06 | 0.09 | 0.06 |
| AMOUNT_PER_VALUE | 6132312600992582704 | 0 | 18.25 | null | 需取 price × 18.25 |
| AMOUNT_PER_AMOUNT | 6977221384739878326 | 0 | 3650 | null | unavailable |

## 相关文件

- `packages/aave-fetcher/src/merkl-api.ts` — resolveCampaignApr + 两处调用
- `packages/aave-fetcher/tests/resolveCampaignApr.test.ts` — 8 个测试
- `backend/src/services/merklForecastService.ts` — extractAprCap, extractDailyRewardsRecords
- `backend/src/services/merklForecastModel.ts` — buildForecastState
- `docs/plans/aav-827-campaign-apr-fallback-spec.md` — spec（需更新反映新方案）

## 约束

1. **显示 0 总是不对的** — 用户误以为"无收益"
2. **AMOUNT_PER_AMOUNT 默认当无 TVL 处理** — AAV-870 另解
3. **无 token price 则不显示 APR** — 用 `campaignAprUnavailable` 标记
4. **resolveCampaignApr 应复用 normalize 函数链** — AAV-868（用 distributionType 判断而非正则）

## Linear Issues

- AAV-827: 主 issue
- AAV-862: 重构 parent（normalize 统一 + campaignType→distributionType 重命名）
- AAV-868: resolveCampaignApr 复用 normalize 函数链
- AAV-870: AMOUNT_PER_AMOUNT 无 TVL
