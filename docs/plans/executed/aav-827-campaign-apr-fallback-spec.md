# AAV-827 Spec: Campaign APR Fallback for AMOUNT Variants

> **Status: Executed** (2026-07-06) — `resolveCampaignApr` 已实现，含 AMOUNT 变体 fallback + price 换算逻辑，测试文件存在。

## Problem

When Merkl `distributionType` contains `_AMOUNT_` (e.g. `FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE`, `FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT`), the `campaign.apr` field is `0` because Merkl cannot compute a USD APR when `rewardTokenPricing=false`. However, `distributionSettings.apr` still contains the intended APR value (in decimal format).

Currently, `campaignApr` in the breakdown is derived from `campaign.apr / 100` (fetcher line 1115), which yields `0` for AMOUNT variants. Frontend users see 0% APR for these campaigns.

## Verified Facts

1. `distributionSettings.apr` is decimal format in ALL variants (verified with real Merkl API data):
   - VALUE: `0.035` = 3.5% USD APR
   - AMOUNT_PER_VALUE: `18.25` = 1825% token/USD/year
   - AMOUNT_PER_AMOUNT: `3650` = 365000% token/token/year

2. AMOUNT variants have `campaign.apr = 0` because `rewardTokenPricing = false`.

3. Forecast calculation (`requiredDaily = remainingBudget / remainingDays`) is identical for all variants in **form**, but **units differ**:
   - VALUE: all values in USD
   - AMOUNT_PER_VALUE: `totalBudget`/`distributedSoFar`/`requiredDaily` in tokens, TVL in USD
   - AMOUNT_PER_AMOUNT: `totalBudget`/`distributedSoFar`/`requiredDaily` in tokens, TVL in target tokens

4. `aprCap` (from `distributionSettings.apr`) is consistent with each variant's unit system:
   - VALUE: percentage APR (USD/USD/year)
   - AMOUNT_PER_VALUE: token rate (tokens/USD/year)
   - AMOUNT_PER_AMOUNT: token ratio (tokens/token/year)

5. Frontend is unaware of campaignType — only `forecastWithTVL` uses it for MAX/FIX/DUTCH branching. No frontend code changes needed.

6. Two data paths exist in backend:
   - Lite file path: reads fetcher's `merkl-opportunity-meta-lite.json`
   - Direct API path: fetches Merkl opportunities directly

## Fix Plan

### Change 1: Fetcher — Campaign APR Resolution by DistributionType

**File**: `packages/aave-fetcher/src/merkl-api.ts`

**New helper function**:
```typescript
const AMOUNT_PATTERN = /_AMOUNT_/;

const resolveCampaignApr = (campaign: any, distributionType?: string): number => {
  if (!campaign) return 0;
  const topApr = Number(campaign.apr || 0);

  const isAmountVariant = typeof distributionType === 'string'
    && AMOUNT_PATTERN.test(distributionType.toUpperCase());

  // VALUE variants: campaign.apr is percentage format → divide by 100
  if (!isAmountVariant && topApr > 0) return topApr / 100;

  // AMOUNT variants: campaign.apr = 0, use distributionSettings.apr (already decimal)
  if (isAmountVariant) {
    const dsApr =
      campaign?.params?.distributionMethodParameters?.distributionSettings?.apr
      ?? campaign?.distributionMethodParameters?.distributionSettings?.apr
      ?? campaign?.distributionSettings?.apr;
    const dsAprNum = Number(dsApr || 0);
    if (dsAprNum > 0) return dsAprNum;
  }

  // Fallback: if AMOUNT variant has no distributionSettings.apr, try campaign.apr / 100
  if (topApr > 0) return topApr / 100;

  return 0;
};
```

**Design decision**: Uses `distributionType` containing `_AMOUNT_` to determine behavior, not `campaign.apr` value comparison. This is more precise because:
- `_AMOUNT_` is the upstream's literal definition of the variant
- A VALUE variant with `campaign.apr = 0` (edge case) should NOT fall back to `distributionSettings.apr`
- An AMOUNT variant with a non-zero `campaign.apr` (hypothetical future) should use `distributionSettings.apr`

**Call site 1** (opportunity loop, ~line 1129):
```typescript
// Old: apr: Number(campaign.apr || 0) / 100,
apr: resolveCampaignApr(campaign, opp.distributionType),
```

**Call site 2** (`fetchMerklCampaignDetails`, ~line 924):
```typescript
// Old: apr: aprPercent / 100,
apr: resolveCampaignApr(campaign, campaign.distributionType),
```

**Why `distributionSettings.apr` doesn't need `/100`**: `campaign.apr` is percentage format (e.g. `3.5` = 3.5%), but `distributionSettings.apr` is decimal format (e.g. `0.035` = 3.5%). The existing code divides by 100 to convert percentage → decimal. The fallback value is already decimal, so no division needed.

### Change 2: Backend — Extract APR Cap Already Handles This

**File**: `backend/src/services/merklForecastService.ts`

`extractAprCap` (lines 194-220) already reads from `distributionSettings.apr` for forecast APR cap. No change needed here — the fallback in Change 1 fixes the `campaignApr` field that flows through breakdowns to the frontend.

### Change 3: No Mapping Table Changes Needed

The existing mapping tables in both `merklForecastModel.ts` (lines 68-82) and `merkl-api.ts` (lines 557-574) already map all AMOUNT variants:

| Pattern | Mapped To |
|---|---|
| `MAX_REWARD_VALUE_PER_LIQUIDITY_AMOUNT` | `MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE` |
| `FIX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE` | `FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE` |
| `FIX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT` | `FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE` |

This is correct because forecast calculation form is identical for all variants. The mapping loss of AMOUNT semantics is intentional and documented in ADR-0024.

**Future note**: If Merkl adds `MAX_REWARD_AMOUNT_PER_LIQUIDITY_VALUE` or `MAX_REWARD_AMOUNT_PER_LIQUIDITY_AMOUNT`, those patterns need new mapping rows. See AAV-862 for unification.

### Change 4: Tests

**File**: `packages/aave-fetcher/tests/resolveCampaignApr.test.ts`

8 test cases covering:
1. VALUE variant without distributionType
2. VALUE variant with explicit non-AMOUNT distributionType
3. AMOUNT_PER_VALUE fallback to distributionSettings.apr
4. AMOUNT_PER_AMOUNT fallback to distributionSettings.apr
5. AMOUNT variant with nested distributionSettings path
6. AMOUNT variant without distributionSettings.apr falls back to campaign.apr / 100
7. VALUE variant ignores distributionSettings.apr
8. Both zero returns 0, null-safe

## Data Flow After Fix

```
Merkl API                    Fetcher                         Backend API (/markets)
─────────                    ───────                         ──────────────────────
campaign.apr = 0       →    resolveCampaignApr(           →    campaignApr = 0.035
distributionType             campaign,                          (was 0, now correct)
= *_AMOUNT_*                 opp.distributionType)
distributionSettings.apr     ↓
= 0.035                      reads distributionSettings
                             .apr (already decimal)
```

## AMOUNT_PER_AMOUNT TVL Consideration

AMOUNT_PER_AMOUNT's TVL must be in target token count (not USD) for forecast calculations to be consistent:
- `requiredDaily / TVL(tokens)` = token/token/day (matches `aprCap` unit: token/token/year)
- If TVL is in USD, the ratio is meaningless

This is handled by `useTokenRateInMetrics` flag and `extractDailyRewardsRecords` which uses `totalInToken` for token-rate campaigns. However, `campaignUsesTokenRateInMetrics` currently only checks for `PRETGE` token type — should also consider AMOUNT variants. This is tracked in AAV-862.

## Out of Scope (Tracked in AAV-862)

- Rename `campaignType` → `distributionType` across codebase
- Unify normalize functions between fetcher and backend
- Add new `CampaignForecastType` enum values for AMOUNT variants
- `campaignUsesTokenRateInMetrics` should consider AMOUNT variants for `totalInToken` priority
- AMOUNT_PER_AMOUNT TVL unit (token vs USD) handling in backend forecast
