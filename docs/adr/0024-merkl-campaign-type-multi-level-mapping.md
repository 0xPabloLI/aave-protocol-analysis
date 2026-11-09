# ADR-0024: Merkl Campaign Type Multi-Level Mapping

Date: 2026-05-29
Updated: 2026-06-17

## Status

Updated — Level 1 (distributionMethod) mapping removed; Level 3 targetAPR fallback added; mapping tables relocated to `aaveapy-doc/merkl-distribution-types.md`

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

### 2026-06-16 Update: Level 1 Removed, Level 3 targetAPR Fallback Added

**Problem**: Level 1 (`distributionMethod`) mapping has never matched in Aave scenarios because Merkl's API always returns an empty string for `distributionMethod` in Aave campaigns. This was dead code adding complexity without value.

Additionally, when a campaign's `distributionType` doesn't match any known pattern, it enters a "half-broken" state: it still appears in the API output with `campaignApr` but missing `campaignType` and all forecast fields. The `distributionType` → `TARGET_TOTAL_APR` mapping is also fragile — names like `AAVE_NET_APR` don't semantically guarantee TARGET_TOTAL_APR.

**Solution**:

1. Remove Level 1 (`distributionMethod`) mapping entirely — dead code
2. Add Level 3 fallback: when Level 2 (`distributionType`) doesn't match, check if `distributionSettings.targetAPR` exists → classify as `TARGET_TOTAL_APR`
3. `targetAPR` existence is the authoritative signal for TARGET_TOTAL_APR — it's a data-level indicator, not a name-based classification
4. Mapping tables relocated to `aaveapy-doc/merkl-distribution-types.md`

### Design Goals

- Correctly map all current Merkl distribution types to our 4 canonical `CampaignForecastType` values
- Eliminate the need for code changes when Merkl adds new `distributionType` values within existing families
- Preserve backwards compatibility with existing campaigns
- Correctly differentiate APR cap sources: `distributionSettings.apr` (MAX/FIX) vs `distributionSettings.targetAPR` (TARGET_TOTAL_APR)

## Decision

Use a **2-level priority mapping**: `distributionType → targetAPR fallback`. Level 1 (distributionMethod) and Level 3 (mode) are both removed.

```
1. distributionType matches known type → return canonical type (Level 2)
2. targetAPR exists and is positive → return TARGET_TOTAL_APR (Level 3 fallback)
3. No match → return null (unrecognized campaign is skipped)
```

### Mapping tables

**All mapping tables have been relocated to [`aaveapy-doc/merkl-distribution-types.md`](../../aaveapy-doc/merkl-distribution-types.md)** — the canonical cross-project knowledge doc.

**Level 1 (distributionMethod): REMOVED** — `distributionMethod` is always empty in Aave campaigns; Level 2 already covers all the same types via `distributionType`.

**Level 2 (distributionType)**: See `aaveapy-doc/merkl-distribution-types.md` Section 2 for the full 13-pattern mapping table.

**Level 3: targetAPR fallback** — When Level 2 doesn't match, if `distributionSettings.targetAPR` is a finite positive number, classify as `TARGET_TOTAL_APR`. This handles future Merkl `distributionType` variants without code changes.

### Full mapping matrix (verified against live data)

| distributionType                       | distributionMethod            | mode    | Resolved by             | → Result                             |
| -------------------------------------- | ----------------------------- | ------- | ----------------------- | ------------------------------------ |
| MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE   | MAX_APR                       | -       | L1 (distributionMethod) | MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE |
| MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT  | MAX_APR                       | -       | L1                      | MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE |
| FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE   | FIX_APR                       | -       | L1                      | FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE |
| FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE  | FIX_APR                       | -       | L1                      | FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE |
| FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT | FIX_APR                       | -       | L1                      | FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE |
| DUTCH_AUCTION                          | DUTCH_AUCTION                 | -       | L1                      | DUTCH_AUCTION                        |
| DUTCH_AUCTION                          | AIRDROP                       | -       | L2 (distributionType)   | DUTCH_AUCTION                        |
| AAVE_NET_APR                           | AAVE_NET_APR                  | MAX_APR | L1                      | TARGET_TOTAL_APR                     |
| AAVE_V4_NET_APR                        | AAVE_V4_NET_APR               | MAX_APR | L1                      | TARGET_TOTAL_APR                     |
| ERC4626_APR                            | ERC4626_APR                   | MAX_APR | L1                      | TARGET_TOTAL_APR                     |
| ERC4626_SPREAD_CAPPED                  | ERC4626_SPREAD_CAPPED         | FIX_APR | L1                      | TARGET_TOTAL_APR                     |
| ERC4626_TARGET_APR_WITH_MERKL          | ERC4626_TARGET_APR_WITH_MERKL | -       | L1                      | TARGET_TOTAL_APR                     |
| SOFR_SPREAD_RATCHET                    | SOFR_SPREAD_RATCHET           | -       | L1                      | TARGET_TOTAL_APR                     |
| DEEL_DISTRIBUTION                      | DEEL_DISTRIBUTION             | -       | L1\*                    | TARGET_TOTAL_APR                     |

\*L1 via distributionMethod=DEEL_DISTRIBUTION (previously L2 via distributionType=DUTCH_AUCTION with method=DEEL_DISTRIBUTION). Now correctly classified as TARGET_TOTAL_APR since DEEL_DISTRIBUTION is a Target Total APR subtype.

### Target Total APR APR cap semantics

| CampaignForecastType                 | APR cap source                   | Unit                   | Frontend interpretation                                 |
| ------------------------------------ | -------------------------------- | ---------------------- | ------------------------------------------------------- |
| MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE | `distributionSettings.apr`       | decimal (0.047 = 4.7%) | Merkl 实付 APR 上限                                     |
| FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE | `distributionSettings.apr`       | decimal                | Merkl 实付 APR 上限                                     |
| TARGET_TOTAL_APR                     | `distributionSettings.targetAPR` | decimal                | 总 APR 目标；前端自行减去 nativeAPR 得到 Merkl 实付部分 |
| DUTCH_AUCTION                        | N/A                              | N/A                    | 无 APR cap                                              |

### Budget-bound mode (`budgetBoundMode`)

`mode` is extracted from `distributionSettings.mode` and passed through as `budgetBoundMode` on `MerklCampaignBreakdown`. It is only present for TARGET_TOTAL_APR campaigns:

| budgetBoundMode | Meaning                                                                  |
| --------------- | ------------------------------------------------------------------------ |
| MAX_APR         | Budget exhausted → dilutive (APR drops below target, campaign continues) |
| FIX_APR         | Budget exhausted → early-end (campaign terminates prematurely)           |

### Implementation

Both normalize functions use `(input: NormalizeCampaignTypeInput)` where:

```typescript
interface NormalizeCampaignTypeInput {
  distributionType?: string;
  targetAPR?: number | string;
}
```

Note: `distributionMethod` was removed (Level 1 dead code). `mode` was previously removed. `targetAPR` added for Level 3 fallback.

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

- **Positive**: Future Merkl distributionType additions within Target Total APR family no longer require code changes (Level 3 targetAPR fallback handles them automatically)
- **Positive**: All 18+ known campaign type combinations now map correctly; no data loss
- **Positive**: "Missing APR cap" errors for AAVE_NET_APR / AAVE_V4_NET_APR campaigns are resolved
- **Positive**: `budgetBoundMode` field enables frontend to display budget-bound behavior correctly
- **Positive** (2026-06-15): `budgetBoundMode` fully passthrough from fetcher → API output; field rules dynamically select FIX/MAX rules based on budgetBoundMode for TARGET_TOTAL_APR
- **Positive** (2026-06-15): `ApiMerklBreakdown` Pick list removed — field visibility now controlled solely by `BREAKDOWN_FIELD_RULES`, reducing sync burden from 3 locations to 2
- **Positive** (2026-06-15): `spreadCap` removed from `MerklCampaignBreakdown` (YAGNI — vault data unavailable, no consumer). Vault mode documented as future reservation
- **Positive** (2026-06-15): TARGET_TOTAL_APR `campaignApr` now outputs Merkl actual-paid APR (not targetAPR). Backend performs APR↔APY conversion (monthly compounding n=12, matching Aave interface and our frontend `rateCalculations.ts`) before subtracting nativeAPY, then converts back to APR. Frontend can treat `campaignApr` identically across all campaign types
- **Neutral**: Function signatures changed — `distributionMethod` removed from `NormalizeCampaignTypeInput`; `targetAPR` added; `extractMaxApr` renamed to `extractAprCap` with added `campaignType` parameter
- **Neutral**: `ForecastCampaignMetaLite` interface retains `rawMode?` for `budgetBoundMode` passthrough
- **Neutral** (2026-06-15): `getBreakdownFieldRule` / `getForecastFieldRule` now accept optional `budgetBoundMode` parameter for dynamic rule selection
- **Neutral** (2026-06-16): `rawDistributionMethod` removed from `ForecastCampaignMetaLite`; `rawDistributionType` and `rawMode` retained
- **Positive** (2026-06-16): Level 1 (`distributionMethod`) dead code removed — simpler codebase, never matched in Aave scenarios
- **Positive** (2026-06-16): Level 3 targetAPR fallback provides forward-compatibility for new Merkl `distributionType` variants
- **Trade-off (DRY) — RESOLVED 2026-08-10**: `normalizeCampaignType` and mapping tables unified in `@internal/aave-shared-contracts/src/campaign-type.ts`. Both fetcher (`merkl-api.ts`) and backend (`merklForecastModel.ts`, `merklApiContract.ts`) import from this single source. The 3-location type duplication (`ForecastCampaignTypeLite` + 2× `CampaignForecastType`) consolidated to 1 definition in shared-contracts. See AAV-862.
- **Precision**: Level 2 matching uses exact equality (`===`) rather than substring matching (`includes`) to prevent future false positives
- **Semantic clarity**: Removing L3 eliminates the conflation between "budget-bound fallback strategy" (mode) and "campaign type classification" (CampaignForecastType)
- **Known precision gap (AAV-827) — RESOLVED 2026-06-17**: AMOUNT 变体映射到独立枚举值，`resolveCampaignApr` 通过 token price 计算 USD APR（有 price 时）或返回 0（无 price 时）。`useTokenRateInMetrics` 改为基于 `rewardTokenPrice` 是否存在（不再基于 `token.type`），使有 price 的 AMOUNT 变体走 USD 路径、无 price 的走 token 路径。forecastService 中 PER_AMOUNT + 有 targetTokenPrice 时 TVL 和 aprCap 均换算到 USD 维度。`merklBreakdownUsesPointsIntensityFields`（控制 points/intensity 字段输出）保持 `PRETGE || POINT`，和 `useTokenRateInMetrics` 解耦。

### AMOUNT Variant Verified Semantics (2026-06-14)

`distributionSettings.apr` 在所有变体中格式一致（decimal），数学验证：

| 变体              | distributionSettings.apr | 公式                                               | 结果单位 |
| ----------------- | ------------------------ | -------------------------------------------------- | -------- |
| VALUE             | 0.035 (3.5%)             | `daily_usd = TVL_usd × apr / 365`                  | USD      |
| AMOUNT_PER_VALUE  | 18.25 (1825%)            | `daily_tokens = TVL_usd × apr / 365`               | token    |
| AMOUNT_PER_AMOUNT | 3650 (365000%)           | `daily_tokens = targetTokenTVL_tokens × apr / 365` | token    |

AMOUNT_PER_AMOUNT 的 TVL 单位是 target token 数量而非 USD，无法仅从 opportunity TVL（USD）计算 daily rewards。`distributedSoFar` 需从 metrics API `dailyRewardsRecords.totalInToken` 累加。

### AMOUNT Variant Data Flow (2026-06-17)

> 完整数据流图、两条路径的字段维度表、维度换算推导见 [`aaveapy-doc/merkl-distribution-types.md` Section 6.7](../../aaveapy-doc/merkl-distribution-types.md)。
