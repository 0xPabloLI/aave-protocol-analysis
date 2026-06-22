# Issue: FIX/MAX Reward distributionType AMOUNT 变体语义映射不精确

## Priority
Medium（不阻塞 P0，但语义正确性应尽快修复）

## Summary

当前 `normalizeCampaignType` 将 `FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE` 和 `FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT` 都映射到 `FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE`，语义不精确。`MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT` 也有同样问题。它们代表不同的计价方式（dollar vs token），应区分映射。

## Context

### 6 种 distributionType 的完整语义

Merkl `distributionType` 命名规律：`{MAX/FIX}_REWARD_{VALUE/AMOUNT}_PER_LIQUIDITY_{VALUE/AMOUNT}`

- `VALUE` = dollar 计价
- `AMOUNT` = token 数量计价

| distributionType | 含义 | rewardTokenPricing | targetTokenPricing | 实际数据 |
|---|---|---|---|---|
| `FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE` | 每 $1 流动性固定 $1 奖励 → Fixed dollar per dollar | `true` | `true` | ✅ 大量 |
| `FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE` | 每 $1 流动性固定 N 个 token → Fixed token per dollar | `false` | `true` | ✅ Base (IPOR), BSC |
| `FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT` | 每 N 个 target token 固定 N 个 reward token → Fixed token per token | `false` | `false` | ✅ Angle (chain 146) |
| `MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE` | Capped: 每 $1 流动性最多 $1 奖励 → Capped dollar per dollar | `true` | `true` | ✅ 大量 |
| `MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT` | Capped: 每 N 个 target token 最多 $1 奖励 → Capped dollar per token | `true` | `false` | ❌ 未找到实际数据 |
| `MAX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE` | Capped: 每 $1 流动性最多 N 个 token → Capped token per dollar | `false` | `true` | ❌ 未找到实际数据 |

### 区分字段

可通过两个字段组合区分：
- `distributionSettings.rewardTokenPricing`：reward token 是否有 USD 价格
- `distributionSettings.targetTokenPricing`：target token 是否有 USD 价格

也可以直接通过 `distributionType` 字符串区分（`VALUE` vs `AMOUNT`）。

### 实际 API 验证数据

| 属性 | Fixed dollar per dollar | Fixed token per dollar | Fixed token per token |
|---|---|---|---|
| Campaign ID | 14885251677142679755 | 6132312600992582704 | (chain 146, AnglesPoint-S2) |
| distributionType | `FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE` | `FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE` | `FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT` |
| rewardTokenPricing | `true` | `false` | `false` |
| targetTokenPricing | `true` | `true` | `false` |
| rewardToken.price | 有值 (0.09) | `null` | `null` |
| top-level apr | 6 (percentage) | 0 (无法换算 USD APR) | 0 |

### 对用户 APR 的影响

| 类型 | USD APR | Token 数量 | 适用场景 |
|---|---|---|---|
| Fixed dollar per dollar | ✅ 固定 | 随 token 价格变化 | 正常有价格的 token 激励 |
| Fixed token per dollar | 随 token 价格变化 | ✅ 固定 | Points token / 无价格 token 激励 |
| Fixed token per token | 随双方 token 价格变化 | ✅ 固定 | 无价格的 token 激励无价格的资产 |

### Aave 现状

Aave 目前只有 `FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE`（Fixed dollar per dollar），从未出现过 `AMOUNT` 变体。但未来可能出现。

## Current Code

### `merklForecastModel.ts:61-71`
```typescript
const DISTRIBUTION_TYPE_PATTERNS = [
  { pattern: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE', result: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' },
  { pattern: 'MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT', result: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' },  // ← 语义丢失
  { pattern: 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE', result: 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE' },
  { pattern: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE', result: 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE' },  // ← 语义丢失
  { pattern: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT', result: 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE' },  // ← 语义丢失
  ...
];
```

### `merkl-api.ts:550-563`
同样的映射表，同样的问题。

## Proposed Fix

### Option A: 新增枚举值

在 `ForecastCampaignTypeLite` 和 `CampaignForecastType` 中新增：
- `FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE`
- `FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT`
- `MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT`
- `MAX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE`（如果未来出现）

每个 pattern 精确映射到对应的枚举值。

影响面：`@internal/aave-shared-contracts` 类型变更 → backend 类型 → API 响应 → frontend 展示

### Option B: 透传 raw distributionType

保留现有 3 种 `CampaignForecastType` 用于 forecast 计算，但 `rawDistributionType` 字段已有透传，frontend 可根据它做精确展示。

影响面：最小，frontend 按需使用 `rawDistributionType`。

### Recommendation

Option B 更安全——forecast 计算逻辑不区分 VALUE/AMOUNT（`requiredDaily = remainingBudget / remainingDays` 对所有变体相同），差异仅在展示层。`rawDistributionType` 已透传，frontend 可自行解析。

## References

- 共享文档：`aaveapy-doc/merkl-distribution-types.md` 第 6 节
- ADR-0024：`docs/adr/0024-merkl-campaign-type-multi-level-mapping.md`
- Schema API：`https://api.merkl.xyz/v4/schemas/distributionMethod`
