# ADR-0024: Merkl Campaign Type Multi-Level Mapping

Date: 2026-05-29
Updated: 2026-06-15

## Status

Updated — AMOUNT variants now map to dedicated enum values (not collapsed to VALUE); resolveCampaignApr computes USD APR via token prices

## Context

Merkl API periodically introduces new `distributionType` values. Previously, `normalizeCampaignType` performed a 1:1 string match on `distributionType` against three known values (`MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE`, `FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE`, `DUTCH_AUCTION`). When Merkl added `AAVE_NET_APR`, `AAVE_V4_NET_APR`, and `ERC4626_APR`, campaigns with these types returned `null` and were skipped, causing `getMerklForecastState` to throw errors and market/forecast data to be lost.

The Merkl API provides three fields per opportunity that carry type semantics:
- `distributionType` — e.g. `MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE`, `AAVE_NET_APR`, `ERC4626_APR`
- `distributionMethod` — e.g. `MAX_APR`, `FIX_APR`, `DUTCH_AUCTION`, `AIRDROP`, `AAVE_NET_APR`
- `mode` — e.g. `MAX_APR`

### 2026-06-13 Update: L3 Removed + TARGET_TOTAL_APR Introduced

**Problem**: 3 Merkl campaigns (AAVE_NET_APR / AAVE_V4_NET_APR) continuously reported "Missing APR cap" since 2026-06-01. Root cause: `extractMaxApr` only reads `distributionSettings.apr`, but Target Total APR types store their APR cap in `distributionSettings.targetAPR`. The `apr` field does not exist for these types.

**Conceptual error in L3**: The `mode` field (e.g. `MAX_APR`, `FIX_APR`) is a **budget-bound fallback strategy**, not a type classification signal. Original L3 mapping `mode=MAX_APR → MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE` conflated two different semantics: "fallback strategy is dilutive" ≠ "campaign is a MAX_REWARD type". Target Total APR campaigns have `mode=MAX_APR` (dilutive fallback) but are NOT MAX_REWARD_VALUE campaigns — they use `targetAPR` instead of `apr` for their APR cap.

**Solution**: Introduce `TARGET_TOTAL_APR` as a 4th `CampaignForecastType`. All 7 Target Total APR subtypes map to this type via L1 (`distributionMethod`). L3 (mode) is deleted as a type signal. `mode` is still extracted and passed through as `budgetBoundMode` for frontend budget-bound display logic.

### Design Goals

- Correctly map all current Merkl distribution types to our 4 canonical `CampaignForecastType` values
- Eliminate the need for code changes when Merkl adds new `distributionType` values within existing families
- Preserve backwards compatibility with existing campaigns
- Correctly differentiate APR cap sources: `distributionSettings.apr` (MAX/FIX) vs `distributionSettings.targetAPR` (TARGET_TOTAL_APR)

## Decision

Use a **2-level priority mapping**: `distributionMethod → distributionType`. Mode is no longer used as a type signal.

```
1. distributionMethod maps directly → return canonical type
2. distributionType matches known type → return canonical type
3. No match → return null (unrecognized campaign is skipped)
```

### Mapping tables

**Level 1: distributionMethod → CampaignForecastType**

| distributionMethod | → Result |
|---|---|
| MAX_APR | MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE |
| FIX_APR | FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE |
| DUTCH_AUCTION | DUTCH_AUCTION |
| AAVE_NET_APR | TARGET_TOTAL_APR |
| AAVE_V4_NET_APR | TARGET_TOTAL_APR |
| ERC4626_APR | TARGET_TOTAL_APR |
| ERC4626_SPREAD_CAPPED | TARGET_TOTAL_APR |
| ERC4626_TARGET_APR_WITH_MERKL | TARGET_TOTAL_APR |
| SOFR_SPREAD_RATCHET | TARGET_TOTAL_APR |
| DEEL_DISTRIBUTION | TARGET_TOTAL_APR |

**Level 2: distributionType → CampaignForecastType** (only when Level 1 has no match)

| distributionType | → Result | Note |
|---|---|---|
| MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE | MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE | |
| MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT | MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE | ⚠️ AMOUNT 语义丢失 → AAV-827 |
| FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE | FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE | |
| FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE | FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE | ⚠️ AMOUNT 语义丢失 → AAV-827 |
| FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT | FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE | ⚠️ AMOUNT 语义丢失 → AAV-827 |
| DUTCH_AUCTION | DUTCH_AUCTION |
| AAVE_NET_APR | TARGET_TOTAL_APR |
| AAVE_V4_NET_APR | TARGET_TOTAL_APR |
| ERC4626_APR | TARGET_TOTAL_APR |
| ERC4626_SPREAD_CAPPED | TARGET_TOTAL_APR |
| ERC4626_TARGET_APR_WITH_MERKL | TARGET_TOTAL_APR |
| SOFR_SPREAD_RATCHET | TARGET_TOTAL_APR |
| DEEL_DISTRIBUTION | TARGET_TOTAL_APR |

**Level 3: REMOVED** — `mode` is no longer used as a type classification signal. It is passed through as `budgetBoundMode` for frontend display logic.

### Full mapping matrix (verified against live data)

| distributionType | distributionMethod | mode | Resolved by | → Result |
|---|---|---|---|---|
| MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE | MAX_APR | - | L1 (distributionMethod) | MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE |
| MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT | MAX_APR | - | L1 | MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE |
| FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE | FIX_APR | - | L1 | FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE |
| FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE | FIX_APR | - | L1 | FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE |
| FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT | FIX_APR | - | L1 | FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE |
| DUTCH_AUCTION | DUTCH_AUCTION | - | L1 | DUTCH_AUCTION |
| DUTCH_AUCTION | AIRDROP | - | L2 (distributionType) | DUTCH_AUCTION |
| AAVE_NET_APR | AAVE_NET_APR | MAX_APR | L1 | TARGET_TOTAL_APR |
| AAVE_V4_NET_APR | AAVE_V4_NET_APR | MAX_APR | L1 | TARGET_TOTAL_APR |
| ERC4626_APR | ERC4626_APR | MAX_APR | L1 | TARGET_TOTAL_APR |
| ERC4626_SPREAD_CAPPED | ERC4626_SPREAD_CAPPED | FIX_APR | L1 | TARGET_TOTAL_APR |
| ERC4626_TARGET_APR_WITH_MERKL | ERC4626_TARGET_APR_WITH_MERKL | - | L1 | TARGET_TOTAL_APR |
| SOFR_SPREAD_RATCHET | SOFR_SPREAD_RATCHET | - | L1 | TARGET_TOTAL_APR |
| DEEL_DISTRIBUTION | DEEL_DISTRIBUTION | - | L1* | TARGET_TOTAL_APR |

*L1 via distributionMethod=DEEL_DISTRIBUTION (previously L2 via distributionType=DUTCH_AUCTION with method=DEEL_DISTRIBUTION). Now correctly classified as TARGET_TOTAL_APR since DEEL_DISTRIBUTION is a Target Total APR subtype.

### Target Total APR APR cap semantics

| CampaignForecastType | APR cap source | Unit | Frontend interpretation |
|---|---|---|---|
| MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE | `distributionSettings.apr` | decimal (0.047 = 4.7%) | Merkl 实付 APR 上限 |
| FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE | `distributionSettings.apr` | decimal | Merkl 实付 APR 上限 |
| TARGET_TOTAL_APR | `distributionSettings.targetAPR` | decimal | 总 APR 目标；前端自行减去 nativeAPR 得到 Merkl 实付部分 |
| DUTCH_AUCTION | N/A | N/A | 无 APR cap |

### Budget-bound mode (`budgetBoundMode`)

`mode` is extracted from `distributionSettings.mode` and passed through as `budgetBoundMode` on `MerklCampaignBreakdown`. It is only present for TARGET_TOTAL_APR campaigns:

| budgetBoundMode | Meaning |
|---|---|
| MAX_APR | Budget exhausted → dilutive (APR drops below target, campaign continues) |
| FIX_APR | Budget exhausted → early-end (campaign terminates prematurely) |

### Implementation

Both normalize functions use `(input: NormalizeCampaignTypeInput)` where:

```typescript
interface NormalizeCampaignTypeInput {
  distributionType?: string | null;
  distributionMethod?: string | null;
}
```

Note: `mode` was removed from the interface. It is still extracted separately for `budgetBoundMode` passthrough.

Applied to:
- `normalizeCampaignType` in `merklForecastModel.ts`
- `normalizeForecastCampaignTypeLite` in `merkl-api.ts`
- Call sites in `merklForecastService.ts`

APR cap extraction changed from `extractMaxApr(campaign)` to `extractAprCap(campaign, campaignType)`: TARGET_TOTAL_APR reads `distributionSettings.targetAPR`, other types read `distributionSettings.apr`.

## Alternatives Considered

### A. Expand distributionType list (status quo approach)
- Add `AAVE_NET_APR`, `AAVE_V4_NET_APR`, `ERC4626_APR` to the known type list
- Rejected: requires code change every time Merkl adds a new distributionType; no forward-compatibility

### B. Default unknown types to MAX
- Map any unrecognized distributionType to `MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE`
- Rejected: overly aggressive; `AIRDROP` and `DEEL_DISTRIBUTION` methods should not silently become MAX campaigns

### C. ~~Two-level mapping (distributionMethod + distributionType only, no mode)~~
- Originally rejected because "AAVE_NET_APR where neither distributionMethod nor distributionType is a known key"
- **2026-06-13: This alternative is now the chosen approach** — AAVE_NET_APR etc. are added to both L1 and L2 maps targeting `TARGET_TOTAL_APR`, so the 2-level mapping is complete

### D. Keep L3 mode as type signal but add targetAPR fallback
- Would fix the APR cap error but maintain the conceptual error of mapping mode=MAX_APR → MAX type
- Rejected: perpetuates semantic confusion between "budget-bound fallback strategy" and "campaign type classification"

## Consequences

- **Positive**: Future Merkl distributionType additions within Target Total APR family no longer require code changes (as long as `distributionMethod` maps correctly)
- **Positive**: All 18+ known campaign type combinations now map correctly; no data loss
- **Positive**: "Missing APR cap" errors for AAVE_NET_APR / AAVE_V4_NET_APR campaigns are resolved
- **Positive**: `budgetBoundMode` field enables frontend to display budget-bound behavior correctly
- **Positive** (2026-06-15): `budgetBoundMode` fully passthrough from fetcher → API output; field rules dynamically select FIX/MAX rules based on budgetBoundMode for TARGET_TOTAL_APR
- **Positive** (2026-06-15): `ApiMerklBreakdown` Pick list removed — field visibility now controlled solely by `BREAKDOWN_FIELD_RULES`, reducing sync burden from 3 locations to 2
- **Positive** (2026-06-15): `spreadCap` removed from `MerklCampaignBreakdown` (YAGNI — vault data unavailable, no consumer). Vault mode documented as future reservation
- **Neutral**: Function signatures changed — `mode` removed from `NormalizeCampaignTypeInput`; `extractMaxApr` renamed to `extractAprCap` with added `campaignType` parameter
- **Neutral**: `ForecastCampaignMetaLite` interface retains `rawMode?` for `budgetBoundMode` passthrough
- **Neutral** (2026-06-15): `getBreakdownFieldRule` / `getForecastFieldRule` now accept optional `budgetBoundMode` parameter for dynamic rule selection
- **Trade-off (DRY)**: `merklForecastModel.ts` and `merkl-api.ts` each define their own mapping tables + normalize functions with identical logic. This duplication is intentional: the former handles backend runtime normalization, the latter handles lite file preprocessing in the fetcher package. The cost is that new mapping entries must be added to both files — accepted as a 2-location sync burden.
- **Precision**: Level 2 matching uses exact equality (`===`) rather than substring matching (`includes`) to prevent future false positives
- **Semantic clarity**: Removing L3 eliminates the conflation between "budget-bound fallback strategy" (mode) and "campaign type classification" (CampaignForecastType)
- **Known precision gap (AAV-827) — RESOLVED 2026-06-15**: AMOUNT 变体现在映射到独立枚举值（`FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE`、`FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT`、`MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT`），不再折叠到 VALUE。`resolveCampaignApr` 使用 `AMOUNT_VARIANT_TYPES` Set 判断变体，并通过 token price 计算真正的 USD APR。若 price 缺失，返回 `campaignAprUnavailableReason` 标记。长期统一 normalize 函数见 AAV-862。

### AMOUNT Variant Verified Semantics (2026-06-14)

`distributionSettings.apr` 在所有变体中格式一致（decimal），数学验证：

| 变体 | distributionSettings.apr | 公式 | 结果单位 |
|---|---|---|---|
| VALUE | 0.035 (3.5%) | `daily_usd = TVL_usd × apr / 365` | USD |
| AMOUNT_PER_VALUE | 18.25 (1825%) | `daily_tokens = TVL_usd × apr / 365` | token |
| AMOUNT_PER_AMOUNT | 3650 (365000%) | `daily_tokens = targetTokenTVL_tokens × apr / 365` | token |

AMOUNT_PER_AMOUNT 的 TVL 单位是 target token 数量而非 USD，无法仅从 opportunity TVL（USD）计算 daily rewards。`distributedSoFar` 需从 metrics API `dailyRewardsRecords.totalInToken` 累加。
