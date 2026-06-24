# ADR-0032: borrowBlacklist at CampaignGroup level + offsetLevel default 'spoke'

## Status: Implemented

## Context

Two related issues in Merkl incentive processing:

1. **BORROW_BL detection (AAV-924)**: Merkl API opportunities with `BORROW_BL` suffix in `identifier` mean "user has borrow position → supply incentive goes to zero" (binary exclusion). No code handled this.

2. **offsetLevel default (AAV-921)**: V4 contract-layer collateral is computed per-Spoke (cross-Hub but not cross-Spoke), but `resolveOffsetReserveIds` defaulted to `'hub'` (normalized to `'reserve'` = exact match only), which is too restrictive.

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

### D2: offsetLevel default from `'hub'` to `'spoke'`

Change default `offsetLevel` parameter in `resolveOffsetReserveIds`, `composedNetPositionConstraint`, `detectNetPositionConstraint`, and `extractNetPositionConstraint` from `'hub'` to `'spoke'`.

Rationale:
- `normalizeOffsetLevel('hub')` = `'reserve'` (exact 4-segment match) — too restrictive for V4
- `normalizeOffsetLevel('spoke')` = `'spoke-cross-hub'` (3-segment prefix match) — matches contract semantics
- V3 path unaffected (always uses pool prefix matching regardless of offsetLevel)

## Consequences

- API consumers see `borrowBlacklist: true` on Merkl CampaignGroups with BORROW_BL opps
- Frontend must implement: `if (group.borrowBlacklist && userBorrowAmount > 0) effectiveApr = 0`
- V4 NPC offset matching now defaults to spoke scope (broader than before)
- V3 behavior unchanged
