# ADR-0024: Merkl Campaign Type Multi-Level Mapping

Date: 2026-05-29

## Status

Accepted

## Context

Merkl API periodically introduces new `distributionType` values. Previously, `normalizeCampaignType` performed a 1:1 string match on `distributionType` against three known values (`MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE`, `FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE`, `DUTCH_AUCTION`). When Merkl added `AAVE_NET_APR`, `AAVE_V4_NET_APR`, and `ERC4626_APR`, campaigns with these types returned `null` and were skipped, causing `getMerklForecastState` to throw errors and market/forecast data to be lost.

The Merkl API provides three fields per opportunity that carry type semantics:
- `distributionType` — e.g. `MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE`, `AAVE_NET_APR`, `ERC4626_APR`
- `distributionMethod` — e.g. `MAX_APR`, `FIX_APR`, `DUTCH_AUCTION`, `AIRDROP`, `AAVE_NET_APR`
- `mode` — e.g. `MAX_APR`

These fields have different discriminative power. `distributionMethod` is the strongest signal (maps directly to our 3 canonical types), followed by `distributionType`, then `mode` as a last resort.

### Design Goals

- Correctly map all current and future Merkl distribution types to our 3 canonical `CampaignForecastType` values
- Eliminate the need for code changes when Merkl adds new `distributionType` values
- Preserve backwards compatibility with existing campaigns

## Decision

Use a **3-level priority mapping**: `distributionMethod → distributionType → mode`.

```
1. distributionMethod maps directly → return canonical type
2. distributionType matches known type → return canonical type
3. mode maps to canonical type → return canonical type
4. No match → return null (unrecognized campaign is skipped)
```

### Mapping tables

**Level 1: distributionMethod → CampaignForecastType**

| distributionMethod | → Result |
|---|---|
| MAX_APR | MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE |
| FIX_APR | FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE |
| DUTCH_AUCTION | DUTCH_AUCTION |

**Level 2: distributionType → CampaignForecastType** (only when Level 1 has no match)

| distributionType | → Result |
|---|---|
| MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE | MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE |
| FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE | FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE |
| DUTCH_AUCTION | DUTCH_AUCTION |

**Level 3: mode → CampaignForecastType** (only when Levels 1–2 have no match)

| mode | → Result |
|---|---|
| MAX_APR | MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE |

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
| DUTCH_AUCTION | DEEL_DISTRIBUTION | - | L2 | DUTCH_AUCTION |
| AAVE_NET_APR | AAVE_NET_APR | MAX_APR | L3 (mode) | MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE |
| AAVE_V4_NET_APR | AAVE_V4_NET_APR | MAX_APR | L3 | MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE |
| ERC4626_APR | ERC4626_APR | MAX_APR | L3 | MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE |

### Implementation

Both normalize functions changed from `(distributionType: string)` to `(input: NormalizeCampaignTypeInput)` where:

```typescript
interface NormalizeCampaignTypeInput {
  distributionType?: string | null;
  distributionMethod?: string | null;
  mode?: string | null;
}
```

Applied to:
- `normalizeCampaignType` in `merklForecastModel.ts`
- `normalizeForecastCampaignTypeLite` in `merkl-api.ts`
- Both call sites in `merklForecastService.ts`

## Alternatives Considered

### A. Expand distributionType list (status quo approach)
- Add `AAVE_NET_APR`, `AAVE_V4_NET_APR`, `ERC4626_APR` to the known type list
- Rejected: requires code change every time Merkl adds a new distributionType; no forward-compatibility

### B. Default unknown types to MAX
- Map any unrecognized distributionType to `MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE`
- Rejected: overly aggressive; `AIRDROP` and `DEEL_DISTRIBUTION` methods should not silently become MAX campaigns

### C. Two-level mapping (distributionMethod + distributionType only, no mode)
- Would fail for `AAVE_NET_APR` / `AAVE_V4_NET_APR` / `ERC4626_APR` where neither distributionMethod nor distributionType is a known key
- Rejected: incomplete coverage

## Consequences

- **Positive**: Future Merkl distributionType additions no longer require code changes (as long as `distributionMethod` or `mode` maps correctly)
- **Positive**: All 11 known campaign type combinations now map correctly; no data loss
- **Positive**: Test coverage: 34 new tests across 4 test files
- **Neutral**: Function signatures changed from `(string)` to `(object)` — breaking API change for any external consumer (none exist)
- **Neutral**: `ForecastCampaignMetaLite` interface gained `rawDistributionType?` and `rawMode?` fields for debugging transparency
