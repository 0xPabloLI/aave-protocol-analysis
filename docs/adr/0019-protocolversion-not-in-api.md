# ADR-0019: protocolVersion Not Exposed in API Response

Date: 2026-05-25

## Status

Accepted

## Context

`protocolVersion` (`'v3' | 'v4'`) exists inside the fetcher layer as an incentive matching key:

| Source | Location | Value | Purpose |
|---|---|---|---|
| Merkl | `deriveProtocolVersion()` (ADR-0018) | Derived from type/address | Filter campaigns by protocol version in `findMatchingMerklOpportunities()` |
| Merit | `createIndexEntry()` L1080 | Hardcoded `'v3'` | Reserved for future V4 data from Merit |
| Brevis | `campaignsIndex` L684 | Hardcoded `'v3'` | Reserved for future V4 data from Brevis |

The fetcher uses `protocolVersion` to prevent cross-version pollution (e.g. V4 Merkl campaigns matching V3 reserves), but it is **not written into `RuntimeReserveData`** and therefore absent from the API response (25 fields, no `protocolVersion`).

Meanwhile, the frontend independently derives protocol version from `marketName`:

```ts
// aaveapy/src/lib/protocolVersion.ts
function getProtocolVersion(marketName: string): 'v3' | 'v4' {
  if (marketName.toLowerCase().startsWith('aavev4')) return 'v4';
  return 'v3';
}
```

This is called 12+ times across the frontend for V4 badges, Hub chip styling, rate simulation fallback skips, and filter/sort logic.

### Why this question arose

During investigation of V4 data completeness, the absence of `protocolVersion` in the API response was initially suspected as a gap. Further analysis showed it is an intentional design — the field exists only where it serves a functional purpose (incentive matching), not as a general-purpose metadata field.

## Decision

**Do not add `protocolVersion` to `RuntimeReserveData` or the API response.**

Rationale:

1. **No consumer needs it from the API.** The frontend already has a stable, zero-cost derivation from `marketName` naming convention (`AaveV4*` prefix). Adding it to the API would be redundant.

2. **`marketName` naming convention is stable.** Aave SDK enforces `AaveV3{Market}` / `AaveV4{Market}` naming. This convention is the canonical source of truth for protocol version, used consistently by backend (fetcher `index.ts:520`) and frontend.

3. **Incentive-internal `protocolVersion` serves a different purpose.** It is a matching key to prevent cross-version pollution in incentive aggregation, not a reserve metadata field. Its scope is confined to the fetcher's incentive adapter layer.

4. **Adding it would create two sources of truth.** If both `marketName` prefix and `protocolVersion` field could indicate version, any inconsistency between them would be a bug class that doesn't exist today.

## Alternatives Considered

### A. Add `protocolVersion` to `RuntimeReserveData` and API response

- Pro: explicit, no naming-convention dependency
- Con: redundant with `marketName` prefix; creates dual-source-of-truth risk; adds field to 354+ reserve payloads for zero functional gain
- Rejected

### B. Add `protocolVersion` only for V4 reserves (where `hubId`/`spokeId` exist)

- Pro: minimal payload addition
- Con: inconsistent field presence makes type modeling awkward (`protocolVersion?: 'v3' | 'v4'`); still redundant with `marketName`
- Rejected

### C. Status quo (this ADR)

- Pro: zero redundancy, single source of truth, no payload bloat
- Con: frontend depends on `marketName` naming convention (which is stable and enforced by Aave SDK)
- Accepted

## Consequences

- **Positive**: Single source of truth for protocol version (`marketName` prefix); no dual-source inconsistency risk
- **Positive**: Lean API payload (no redundant field across 354+ reserves)
- **Positive**: `protocolVersion` in incentive adapters remains an internal implementation detail with clear scope
- **Neutral**: Frontend must continue deriving version from `marketName`; if Aave ever breaks the naming convention, both backend (fetcher L520) and frontend would need coordinated updates
- **Neutral**: Future incentive sources (Merit/Brevis V4 campaigns) will use the same pattern — `protocolVersion` stays internal to the matching logic

## References

- ADR-0018: Merkl CampaignGroup Protocol Version Derivation (`docs/adr/0018-merkl-campaigngroup-protocol-version.md`)
- Incentive matching documentation: `aaveapy-doc/v3-v4-incentive-matching.md`
- Frontend version derivation: `aaveapy/src/lib/protocolVersion.ts`
- Backend Merkl version filter: `packages/aave-fetcher/src/index.ts:520-521`
