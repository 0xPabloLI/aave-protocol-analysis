# ADR-0032: borrowBlacklist at CampaignGroup level + deterministic offsetLevel per opportunityType

## Status: Implemented

## Context

Two related issues in Merkl incentive processing:

1. **BORROW_BL detection (AAV-924)**: Merkl API opportunities with `BORROW_BL` suffix in `identifier` mean "user has borrow position → supply incentive goes to zero" (binary exclusion). Detection also via `hasBlacklistWithBorrowHook` (blacklist + hookType=14). No code handled this.

2. **offsetLevel mapping (AAV-921)**: `resolveOffsetReserveIds` defaulted to `'hub'` (→ `'reserve'` after normalization), which was too restrictive for V4 HUB_SUPPLY opps that lack spokeAddress. The previous attempt to default to `'spoke'` was also wrong — there is no one-size-fits-all default.

### Key insight: offsetLevel is deterministic per opportunityType

The offset scope depends on **Merkl's own reward calculation logic**, not Aave V4's health factor isolation. Each opportunityType has a fixed set of anchorable dimensions, which determines the offset level:

| opportunityType | Anchorable dimensions | offsetLevel | Reason |
|---|---|---|---|
| `AAVE_V4_SPOKE_SUPPLY` | chainId + spoke + token + hub (4 segments) | `'reserve'` | Has all 4 segments, offset also exact match |
| `AAVE_V4_HUB_SUPPLY` | Missing spokeAddress | `'hub-cross-spoke'` | Can only resolve to hub dimension |
| `AAVE_NET_*` (V3) | pool + token | `'reserve'` | Same pool exact match |
| `AAVE_V4_NET_APR` | Missing spokeAddress | `'hub-cross-spoke'` | Same as HUB_SUPPLY |

### Dead paths removed

- `'cross-market'` offsetLevel was driven by `hasCrossMarketNpc` (hookType=14), but hookType=14 opps have **empty offsetTokenAddresses** (`params.tokens` is empty). Without offset tokens, the offset resolve logic is never entered. `cross-market` was therefore dead code.
- `'spoke-cross-hub'` offsetLevel had no actual consumer — SPOKE_SUPPLY correctly uses `'reserve'` (exact 4-segment match).
- `normalizeOffsetLevel` function and `'hub'`/`'spoke'` aliases removed as part of simplification.

### hookType=14 note

The interpretation of hookType=14 as "BORROW_BL" (borrowers on any market are excluded) is reverse-engineered from Merkl API data. No official Merkl documentation confirms this. The `hasHookType14` function is retained as a diagnostic utility, but offsetLevel logic no longer depends on it.

## Decision

### D1: `borrowBlacklist` at CampaignGroup level

Place `borrowBlacklist?: boolean` on `CampaignGroup` (same level as `netPositionConstraint`), not on `MerklCampaignBreakdown`.

Rationale:
- BORROW_BL is an opportunity-level property affecting all breakdowns in the group
- Frontend simulation checks `borrowBlacklist` first (short-circuit to zero), then `netPositionConstraint` (proportional offset)
- Consistent with `netPositionConstraint` placement

Alternatives considered:
- **breakdown level**: Redundant (same constraint repeated per breakdown)
- **reuse `netPositionConstraint`**: Semantically different (binary exclusion vs proportional offset)

### D2: Deterministic offsetLevel per opportunityType (no fallback)

Replace the ternary chain with `hasCrossMarketNpc` fallback with an explicit mapping based on `opportunityType`. Default to `'reserve'` for unrecognized types.

Function signatures (`composedNetPositionConstraint`, `detectNetPositionConstraint`, `extractNetPositionConstraint`) default to `'reserve'`.

`OffsetLevel` type reduced to `'reserve' | 'hub-cross-spoke'` — no aliases, no `'spoke-cross-hub'`, no `'cross-market'`.

## Consequences

- API consumers see `borrowBlacklist: true` on Merkl CampaignGroups with BORROW_BL opps
- Frontend must implement: `if (group.borrowBlacklist && userBorrowAmount > 0) effectiveApr = 0`
- offsetLevel is now deterministic per opportunityType — no runtime heuristics, no fallback ambiguity
- V3 behavior unchanged (`'reserve'` = pool-internal exact match)
- V4 SPOKE_SUPPLY uses `'reserve'` (4-segment exact match)
- V4 HUB_SUPPLY / V4 NET_APR uses `'hub-cross-spoke'` (cross-spoke within same hub)
