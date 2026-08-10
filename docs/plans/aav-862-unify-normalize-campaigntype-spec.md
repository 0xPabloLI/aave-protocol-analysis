# Spec: AAV-862 — 统一 normalize campaignType 逻辑

> **Status: Active**
> **Issue**: AAV-862 (Ready for agent, Medium)
> **Scope**: Scope 1 only (统一 normalize 函数). Scope 2 (重命名) + Scope 3 (AMOUNT 变体语义) deferred.
> **Grill Date**: 2026-08-10

## Background

当前 `normalizeCampaignType`（backend `merklForecastModel.ts`）和 `normalizeForecastCampaignTypeLite`（fetcher `merkl-api.ts`）逻辑完全一致但各自独立维护。同一 7 值 union type 被定义 **3 次**：

1. `ForecastCampaignTypeLite` in `@internal/aave-shared-contracts/src/index.ts`
2. `CampaignForecastType` in `backend/src/services/merklForecastModel.ts`
3. `CampaignForecastType` in `backend/src/lib/merklApiContract.ts` (未记录的额外重复)

ADR-0024 记录此重复为"有意"（2-location sync burden），但实际存在 3 处类型定义。本 spec 消除所有重复。

## Decisions (from Grill)

| #   | Decision                                           | Rationale                                                                           |
| --- | -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| D1  | 仍然统一，更新 ADR-0024                            | 消除 3 处类型重复 + 2 处函数重复；shared-contracts 已有运行时函数先例（`units.ts`） |
| D2  | 新文件 `campaign-type.ts`                          | 语义独立于 `units.ts`（数值转换 vs 字符串→枚举映射）                                |
| D3  | 统一类型名 `ForecastCampaignTypeLite`              | 已在 shared-contracts 定义，是 source of truth                                      |
| D4  | `merklApiContract.ts` 从 shared-contracts import   | 消除第 3 份拷贝，保留 contract 规则（`BREAKDOWN_FIELD_RULES` 等）                   |
| D5  | 统一函数名 `normalizeCampaignType`                 | 更短更通用；"Lite"后缀属于 fetcher 特有风格                                         |
| D6  | `toFinitePositiveNumber` 移为内部函数              | 不 export，是实现细节                                                               |
| D7  | `normalizeByDistributionType` 内联                 | 无独立消费者，fetcher 已内联                                                        |
| D8  | 映射表 `DISTRIBUTION_TYPE_PATTERNS` 移为模块级常量 | 不 export，是实现细节                                                               |
| D9  | 输入接口统一为 `NormalizeCampaignTypeInput`        | 从 shared-contracts export                                                          |
| D10 | 直接 import（无 re-export）                        | 符合 `@internal/*` import 规范，减少间接层                                          |
| D11 | 直接改名（无 alias）                               | alias 永久保留命名不一致，违背统一目标                                              |
| D12 | 测试合并到 `tests/campaign-type.test.ts`           | 合并 ~11 场景为完整矩阵                                                             |
| D13 | Scope 2 (重命名) 拆为独立 follow-up                | 跨仓库 API breaking change，协调成本高                                              |
| D14 | Scope 3 (AMOUNT 变体语义) 标记已通过子 issue 解决  | 剩余需产品决策                                                                      |

## Impact Scope

### 1. New file: `packages/aave-shared-contracts/src/campaign-type.ts`

```typescript
// Re-export from index.ts
export type { ForecastCampaignTypeLite } from "./index.js"; // already defined there
export { normalizeCampaignType } from "./campaign-type.js";
export type { NormalizeCampaignTypeInput } from "./campaign-type.js";

// Internal (not exported):
// - DISTRIBUTION_TYPE_PATTERNS (13-pattern mapping table)
// - toFinitePositiveNumber (helper)
// - normalizeByDistributionType logic (inlined)
```

### 2. `packages/aave-shared-contracts/src/index.ts`

Add re-export:

```typescript
export { normalizeCampaignType } from "./campaign-type.js";
export type { NormalizeCampaignTypeInput } from "./campaign-type.js";
```

Note: `ForecastCampaignTypeLite` is already defined and exported from `index.ts` (L97-104). It stays there (other types like `MerklCampaignBreakdown` reference it). `campaign-type.ts` imports it from `./index.js` or it's defined inline.

**Design choice**: `ForecastCampaignTypeLite` type definition stays in `index.ts` (co-located with breakdown types). `campaign-type.ts` imports the type and provides the normalize function + input interface.

### 3. `packages/aave-shared-contracts/tests/campaign-type.test.ts` (new)

Merged test suite — 11 scenarios from the matrix below.

### 4. `backend/src/services/merklForecastModel.ts`

- **Delete**: `CampaignForecastType` type definition (L4-11)
- **Delete**: `NormalizeCampaignTypeInput` interface (L55-58)
- **Delete**: `DISTRIBUTION_TYPE_PATTERNS` constant (L60-74)
- **Delete**: `normalizeByDistributionType` function (L76-83)
- **Delete**: `toFinitePositiveNumber` function (L85-92)
- **Delete**: `normalizeCampaignType` function (L94-102)
- **Add**: `import { normalizeCampaignType } from "@internal/aave-shared-contracts"`
- **Add**: `import type { ForecastCampaignTypeLite, NormalizeCampaignTypeInput } from "@internal/aave-shared-contracts"`
- **Replace**: All `CampaignForecastType` references → `ForecastCampaignTypeLite` (in `BuildForecastStateInput`, `MerklForecastState`)
- **Keep**: `safeNumber` helper, `buildForecastState` function, `SECONDS_PER_DAY`, `MIN_REMAINING_DAYS`

### 5. `backend/src/lib/merklApiContract.ts`

- **Delete**: `CampaignForecastType` type definition (L10-17)
- **Add**: `import type { ForecastCampaignTypeLite } from "@internal/aave-shared-contracts"`
- **Replace**: All `CampaignForecastType` → `ForecastCampaignTypeLite` in `BREAKDOWN_FIELD_RULES`, `FORECAST_FIELD_RULES`, `getBreakdownFieldRule`, `getForecastFieldRule`, `shouldIncludeForecastItem`

### 6. `backend/src/services/merklForecastService.ts`

- **Change import**: Remove `normalizeCampaignType` and `type CampaignForecastType` from `./merklForecastModel.js` import
- **Add import**: `import { normalizeCampaignType } from "@internal/aave-shared-contracts"` + `import type { ForecastCampaignTypeLite } from "@internal/aave-shared-contracts"`
- **Replace**: `CampaignForecastType` → `ForecastCampaignTypeLite` (in `CampaignOpportunityMeta` interface, `extractAprCap` function)

### 7. `backend/src/services/marketsApiSerialize.ts`

- **Change import**: `type CampaignForecastType` from `../lib/merklApiContract.js` → `type ForecastCampaignTypeLite` from `@internal/aave-shared-contracts`
- **Replace**: `CampaignForecastType` → `ForecastCampaignTypeLite` (in generic constraint and fingerprint fixture)

### 8. `backend/src/controllers/merklForecastController.ts`

- **Change import**: `type CampaignForecastType` from `../lib/merklApiContract.js` → `type ForecastCampaignTypeLite` from `@internal/aave-shared-contracts`
- **Replace**: `CampaignForecastType` → `ForecastCampaignTypeLite` (in `buildForecastResponseItem`)

### 9. `packages/aave-fetcher/src/merkl-api.ts`

- **Delete**: `NormalizeForecastCampaignTypeLiteInput` interface (L685-688)
- **Delete**: `FORECAST_LITE_DISTRIBUTION_TYPE_PATTERNS` constant (L690-722)
- **Delete**: `toFinitePositiveNumber` function (L724-732)
- **Delete**: `normalizeForecastCampaignTypeLite` function (L734-756)
- **Add import**: `import { normalizeCampaignType } from "@internal/aave-shared-contracts"` + `import type { NormalizeCampaignTypeInput } from "@internal/aave-shared-contracts"`
- **Replace**: All 5 call sites: `normalizeForecastCampaignTypeLite(...)` → `normalizeCampaignType(...)`

### 10. `packages/aave-fetcher/tests/normalizeForecastCampaignTypeLite.test.ts`

- **Delete**: Entire file (tests merged into shared-contracts)

### 11. `packages/aave-fetcher/tests/merklAmountVariantBatchDedup.test.ts`

- **Change import**: `normalizeForecastCampaignTypeLite` from `../src/merkl-api.js` → `normalizeCampaignType` from `@internal/aave-shared-contracts`
- **Replace**: All `normalizeForecastCampaignTypeLite(...)` → `normalizeCampaignType(...)`

### 12. `backend/tests/merklForecastModel.test.ts`

- **Delete**: All `normalizeCampaignType` tests (L9-135, 9 tests)
- **Change import**: Remove `normalizeCampaignType` from import
- **Add import**: `import { normalizeCampaignType } from "@internal/aave-shared-contracts"` (only if still used in remaining tests — it's not, so just remove)
- **Keep**: `buildForecastState` tests (L137-174, 2 tests)
- **Replace**: `CampaignForecastType` type references if any in remaining tests

### 13. `docs/adr/0024-merkl-campaign-type-multi-level-mapping.md`

Update the "Trade-off (DRY)" consequence:

- Before: "This duplication is intentional... accepted as a 2-location sync burden"
- After: "Normalized — `normalizeCampaignType` and mapping tables unified in `@internal/aave-shared-contracts/src/campaign-type.ts`. Both fetcher and backend import from single source."

## Scenario & Risk Verification Matrix

| #   | Scenario                                                  | Input                                                            | Expected Output                            | Risk Dimension                                 | Source       |
| --- | --------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------- | ------------ |
| S1  | Level 2: MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE exact match | `{ distributionType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' }`   | `'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE'`   | Cross-step contract (type value as Record key) | Both         |
| S2  | Level 2: MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT            | `{ distributionType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT' }`  | `'MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT'`  | Same                                           | Both         |
| S3  | Level 2: FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE             | `{ distributionType: 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE' }`   | `'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE'`   | Same                                           | Both         |
| S4  | Level 2: FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE            | `{ distributionType: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE' }`  | `'FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE'`  | Same                                           | Both         |
| S5  | Level 2: FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT           | `{ distributionType: 'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT' }` | `'FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT'` | Same                                           | Both         |
| S6  | Level 2: DUTCH_AUCTION                                    | `{ distributionType: 'DUTCH_AUCTION' }`                          | `'DUTCH_AUCTION'`                          | Same                                           | Both         |
| S7  | Level 2: 7 Target Total APR subtypes → TARGET_TOTAL_APR   | 7 × `{ distributionType: '<subtype>' }`                          | 7 × `'TARGET_TOTAL_APR'`                   | Same                                           | Both         |
| S8  | Level 3: positive number targetAPR fallback               | `{ targetAPR: 5.0 }`                                             | `'TARGET_TOTAL_APR'`                       | Null/empty boundary (fallback)                 | Both         |
| S9  | Level 3: positive string targetAPR fallback               | `{ targetAPR: '3.5' }`                                           | `'TARGET_TOTAL_APR'`                       | Same                                           | Both         |
| S10 | Level 3: unknown distributionType + targetAPR → fallback  | `{ distributionType: 'UNKNOWN', targetAPR: 2.0 }`                | `'TARGET_TOTAL_APR'`                       | Failure/degradation                            | Both         |
| S11 | Level 2 priority over Level 3                             | `{ distributionType: 'DUTCH_AUCTION', targetAPR: 5.0 }`          | `'DUTCH_AUCTION'`                          | Cross-step contract (priority)                 | Both         |
| S12 | Level 3 rejects targetAPR=0                               | `{ targetAPR: 0 }`                                               | `null`                                     | Null/empty boundary (0 vs null)                | Both         |
| S13 | Level 3 rejects negative targetAPR                        | `{ targetAPR: -1 }`                                              | `null`                                     | Same                                           | Both         |
| S14 | Level 3 rejects NaN targetAPR                             | `{ targetAPR: NaN }`                                             | `null`                                     | Same                                           | Both         |
| S15 | Level 3 rejects non-numeric string targetAPR              | `{ targetAPR: 'not a number' }`                                  | `null`                                     | Same                                           | Both         |
| S16 | Level 3 rejects undefined targetAPR                       | `{ targetAPR: undefined }`                                       | `null`                                     | Same                                           | Both         |
| S17 | distributionMethod ignored (Level 1 removed)              | `{ distributionMethod: 'MAX_APR' }`                              | `null`                                     | API contract (dead field)                      | Both         |
| S18 | Case-insensitive + whitespace-tolerant                    | `{ distributionType: ' dutch_auction ' }`                        | `'DUTCH_AUCTION'`                          | Cross-system key matching                      | Fetcher-only |
| S19 | Empty string distributionType treated as absent           | `{ distributionType: '', targetAPR: 5.0 }`                       | `'TARGET_TOTAL_APR'`                       | Null/empty boundary (empty vs absent)          | Fetcher-only |
| S20 | Empty string distributionType, no targetAPR               | `{ distributionType: '' }`                                       | `null`                                     | Same                                           | Fetcher-only |
| S21 | null input                                                | `null`                                                           | `null`                                     | Null/empty boundary                            | Both         |
| S22 | undefined input                                           | `undefined`                                                      | `null`                                     | Same                                           | Both         |
| S23 | string input (non-object)                                 | `'string'`                                                       | `null`                                     | Same                                           | Both         |
| S24 | number input (non-object)                                 | `42`                                                             | `null`                                     | Same                                           | Fetcher-only |
| S25 | empty object                                              | `{}`                                                             | `null`                                     | Same                                           | Both         |
| S26 | unknown distributionType, no targetAPR                    | `{ distributionType: 'UNKNOWN_TYPE' }`                           | `null`                                     | Failure/degradation                            | Both         |

> **Total: 26 scenarios** (S1-S26). S18-S20 and S24 are fetcher-specific edge cases that must be preserved in the unified version.
>
> **Risk dimensions checked**: Null/empty boundary (S8-S16, S19-S25), Cross-step contract (S1-S7, S11), Failure/degradation (S10, S26), Cross-system key matching (S18), API contract (S17).

## Out of Scope

- **Scope 2**: Rename `campaignType` → `distributionType` across all repos (API breaking change, deferred to follow-up issue)
- **Scope 3**: AMOUNT_PER_AMOUNT forecast semantic fix (needs product decision on display strategy)
- **`buildForecastState`**: Stays in `merklForecastModel.ts` (backend-specific)
- **`BREAKDOWN_FIELD_RULES` / `FORECAST_FIELD_RULES`**: Stay in `merklApiContract.ts` (backend-specific contract)
- **`safeNumber` helper**: Stays in `merklForecastModel.ts` (used by `buildForecastState` only)

## Verification Plan

1. **Build**: `npm run build -w @internal/aave-shared-contracts` → `npm run build -w @internal/aave-fetcher` → `npm run build -w aave-dashboard-backend`
2. **Tests**: `npm run test -w @internal/aave-shared-contracts` (26 scenarios) → `npm run test -w @internal/aave-fetcher` → `npm run test -w aave-dashboard-backend`
3. **Type check**: `npm run test:typecheck`
4. **Full CI**: `npm run ci:remote`
5. **Runtime**: `npm run dev -w aave-dashboard-backend` → verify `/api/markets` response has `campaignType` field with correct values
