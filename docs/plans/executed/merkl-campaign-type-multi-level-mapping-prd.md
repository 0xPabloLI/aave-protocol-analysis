> **Status: Executed** (2026-05-29) — implemented and verified.

# PRD: Merkl Campaign Type Multi-Level Mapping

## Problem

Merkl 新增了 3 种 `distributionType`（`AAVE_NET_APR`, `AAVE_V4_NET_APR`, `ERC4626_APR`），原有的 `normalizeCampaignType` 仅基于单一 `distributionType` 字符串识别，无法处理新类型，导致：

1. `normalizeCampaignType` 返回 `null` → campaign 被跳过
2. `getMerklForecastState` 找不到 campaign → throw error
3. **数据丢失**：market 的 Merkl forecast 数据和 enrichment 数据双双缺失

## Root Cause

Campaign 类型判断只用了 `distributionType` 一个维度。但 Merkl API 中：
- 同一 `distributionType` 可能对应不同 campaign 类型（如 `DUTCH_AUCTION` 既可能是荷兰拍也可能是空投）
- 新增类型（`AAVE_NET_APR` 等）的 `distributionType` 本身无显性映射，但其 `mode` 字段有（`MAX_APR` → `MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE`）

## Solution

**将 campaign 类型识别从单维度改为三级优先级映射**：

```
distributionMethod → distributionType → mode
（命中率最高的优先）
```

### 映射矩阵

| distributionType | distributionMethod | mode | 判断依据 | → 结果 |
|---|---|---|---|---|
| `MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE` | `MAX_APR` | - | **method** 显性 | MAX |
| `MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT` | `MAX_APR` | - | **method** 显性 | MAX |
| `FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE` | `FIX_APR` | - | **method** 显性 | FIX |
| `FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE` | `FIX_APR` | - | **method** 显性 | FIX |
| `FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT` | `FIX_APR` | - | **method** 显性 | FIX |
| `DUTCH_AUCTION` | `DUTCH_AUCTION` | - | **method** 显性 | DUTCH |
| `DUTCH_AUCTION` | `AIRDROP` | - | method 无显性，**type** 显性 | DUTCH |
| `DUTCH_AUCTION` | `DEEL_DISTRIBUTION` | - | method 无显性，**type** 显性 | DUTCH |
| `AAVE_NET_APR` | `AAVE_NET_APR` | `MAX_APR` | method/type 均无显性，**mode** 显性 | MAX |
| `AAVE_V4_NET_APR` | `AAVE_V4_NET_APR` | `MAX_APR` | method/type 均无显性，**mode** 显性 | MAX |
| `ERC4626_APR` | `ERC4626_APR` | `MAX_APR` | method/type 均无显性，**mode** 显性 | MAX |

### API 变更

**`normalizeCampaignType` 签名变更**：

```ts
// Before
normalizeCampaignType(distributionType: string): CampaignForecastType | null

// After
interface NormalizeCampaignTypeInput {
  distributionType?: string;
  distributionMethod?: string;
  mode?: string;
}
normalizeCampaignType(input: NormalizeCampaignTypeInput): CampaignForecastType | null
```

**`normalizeForecastCampaignTypeLite` 同步变更**（`merkl-api.ts`）。

## Impact Scope

| File | Change |
|---|---|
| `merklForecastModel.ts` | `normalizeCampaignType` 签名 + 映射表 |
| `merklForecastService.ts` | 2 个调用点：提取 `distributionMethod` / `mode` 传入新签名 |
| `merkl-api.ts` | `normalizeForecastCampaignTypeLite` 签名 + 映射表；`ForecastCampaignMetaLite` 新增 `rawDistributionType?` / `rawMode?` |

## Test Coverage

- `merklForecastModel.test.ts` — 9 tests（优先级、fallback、null 输入）
- `merklForecastService.test.ts` — 9 tests（调用点字段提取、优先级、tvl 过滤）
- `normalizeForecastCampaignTypeLite.test.ts` — 8 tests
- `buildForecastCampaignMetaLiteMap.test.ts` — 8 tests

## Future-Proofing

新增 `distributionType` 时：
1. 若其 `distributionMethod` 已有显性映射 → **无需改代码**
2. 若其 `mode` 已有映射 → **无需改代码**
3. 若两者都无 → 仅需在 `DISTRIBUTION_METHOD_MAP` 或 `MODE_MAP` 中添加一行
