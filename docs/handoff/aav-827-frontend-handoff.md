# AAV-827 前端 Handoff: AMOUNT 变体 Campaign APR 处理

## 后端已完成

### 核心变更

1. **`resolveCampaignApr` 正确计算 AMOUNT 变体 USD APR**：`dsApr × rewardTokenPrice`（FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE）或 `dsApr × (rewardTokenPrice / targetTokenPrice)`（FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT / MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT）
2. **`merklBreakdownUsesPointsIntensityFields` 扩展为 `PRETGE || POINT`**：AMOUNT 变体的 points token（`token.type === 'POINT'`）现在也输出 `pointsPerThousandUsd`
3. **去掉 `campaignAprUnavailableReason`**：price 缺失时 `campaignApr = 0`，后端 log 记录即可，前端不需要区分 unavailable 原因

### API 响应变化

```typescript
// MerklCampaignBreakdown 现在的结构（campaignAprUnavailableReason 已移除）
interface MerklCampaignBreakdown extends BaseCampaignBreakdown {
  campaignApr: number;  // USD APR (decimal, e.g. 0.035 = 3.5%); 0 = 无收益或无法计算
  pointsPerThousandUsd?: number;  // 现在 AMOUNT 变体(POINT类型)也有此字段
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

### 数据流（前端视角）

AMOUNT 变体 campaign 的数据流：

```
Merkl API → dsApr (points/USD/year 或 points/token/year)
                    ↓
           resolveCampaignApr: dsApr × tokenPrice → campaignApr (USD APR)
                    ↓
           如果 price 缺失 → campaignApr = 0
                    ↓
           merklBreakdownUsesPointsIntensityFields(POINT=true) → pointsPerThousandUsd
```

**关键**：`campaignApr = 0` + `pointsPerThousandUsd > 0` = price 缺失的 AMOUNT 变体。

## 前端需要做的

### 1. `TYDRO_POINT_TO_USD_RATE` 改为只对 Ink 生效

**文件**: `src/lib/tydro.ts`

当前 `TYDRO_POINT_TO_USD_RATE = 1` 是全局默认，所有 points token 都用 rate=1 计算 APR。需要改为：
- TydroInkPoints（Ink campaign）→ rate 由 InkAprCalculator 的 FDV slider 控制，默认 1.0
- 其他 points token（AMOUNT 变体）→ rate 默认 0

**原因**：AMOUNT 变体的 points token（ipor-fusion-points、Gravity Points、LendPoints 等）没有 USD 定价，rate=1 会产生虚假 APR。

### 2. 渲染逻辑：`campaignApr = 0` + `pointsPerThousandUsd > 0` + `rate = 0` → 显示 0%

不需要特殊处理——当 rate=0 时，现有 points APR 计算公式自然输出 0%。

**如果希望更友好**，可以在 IncentiveTooltip 中检测 `campaignApr === 0 && pointsPerThousandUsd > 0` 并显示 em dash 或 tooltip（"Points reward, USD rate unknown"），但这不是必须的。

### 3. 类型定义不需要更新

前端 `MerklCampaignBreakdown` 类型中从未添加过 `campaignAprUnavailableReason`，无需删除。

## 验证数据

部署后检查以下 campaign 的 Merkl breakdown：

| 协议 | Token | token.type | campaignType | 预期 |
|---|---|---|---|---|
| IPOR Fusion | ipor-fusion-points-s2 | POINT | FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE | `pointsPerThousandUsd ≈ 50`，`campaignApr` 取决于 price |
| Gravity | Gravity Points | POINT | FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE 或 _AMOUNT | `pointsPerThousandUsd ≈ 12000` |
| Lendle | LendPoints | POINT | FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE | `pointsPerThousandUsd ≈ 31` |
| Ink | TydroInkPoints | PRETGE | DUTCH_AUCTION | 行为不变，InkAprCalculator 正常 |

## 相关

- AAV-827: 主 issue
- PRD: AAV-876
- Backend commit `9ef5779`: feat(merkl): resolve AMOUNT variant USD APR
- Backend commit `266dd7b`: remove campaignAprUnavailableReason + extend points intensity to POINT type
