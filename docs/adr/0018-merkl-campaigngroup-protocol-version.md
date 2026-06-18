# ADR-0018: Merkl CampaignGroup Protocol Version Derivation

Date: 2026-05-23

## Status

Accepted

## Context

Merkl campaigns (grouped as **CampaignGroups**) are sourced from Merkl API opportunities. A single opportunity may target either V3 or V4 protocol reserves. Without version-aware filtering, a V4 campaign can incorrectly attach to V3 reserves (or vice versa), producing misleading incentive data.

The Merkl API response includes:
- `type` — e.g. `AAVE_NET_LENDING`, `AAVE_V4_HUB_SUPPLY`
- `explorerAddress` — the contract address associated with the opportunity
- `name` — free-text human-readable name
- `protocol.id` — always `"aave"` (does NOT distinguish V3/V4)

### Key Observations (verified against 117 live opportunities, 2026-05-23)

1. **V3 opportunities always use aToken/vToken addresses as `explorerAddress`**, never underlying token addresses.
2. **V4 Spoke opportunities use spoke addresses as `explorerAddress`**.
3. **V4 Hub opportunities use underlying token addresses as `explorerAddress`** (note: underlying tokens are the same address in V3 and V4, so underlying address alone cannot distinguish versions).
4. **Merkl type naming convention**: types starting with `AAVE_V4_` are V4-specific (e.g. `AAVE_V4_HUB_SUPPLY`, `AAVE_V4_SPOKE_SUPPLY`).

### Design Goals

- Correctly assign each CampaignGroup to its target protocol version (v3 or v4)
- Handle future unknown Merkl types without manual list maintenance
- Minimize performance cost

## Decision

Use a **4-step priority-based derivation**:

```
1. type starts with AAVE_V4_ → v4           (zero-cost string prefix check)
2. Unambiguous address lookup → v3/v4       (aToken/vToken/spoke Map.get())
3. V4 underlying token lookup → v4           (only V4 does Hub Supply via underlying)
4. Default → v3                              (conservative: V3 should never eat V4 campaigns)
```

### Unambiguous lookup table construction

Built once per fetch cycle from `baseDataset`:

| Address type | Source | Maps to |
|---|---|---|
| aToken address (all reserves) | `r.aTokenAddress` | reserve's version |
| vToken address (all reserves) | `r.vTokenAddress` | reserve's version |
| spoke address (V4 only) | `r.spokeAddress` | `'v4'` |

V3 tokens are excluded from this lookup because V3 never uses underlying token as `explorerAddress`.
V4 underlying tokens are in a separate lookup (only maps to v4) because they can be shared with V3.

### Complexity

- Memory: ~450 map entries, <10KB
- Computation: O(1) per opportunity (string prefix + one Map lookup)

## Alternatives Considered

### A. Type-field-only matching (status quo before this ADR)
- Relied on `type.toUpperCase().includes('V4')` only
- Rejected: cannot handle future types that lack V4 prefix

### B. Name-based parsing
- Parse human-readable opportunity name for version hints
- Rejected: unreliable, free-text varies across Merkl types

### C. Known V3 type list
- Maintain a hardcoded list of V3 types, default everything else
- Rejected: brittle, requires manual updates when Merkl adds new types

### D. explorerAddress-only reverse lookup (without type fallback)
- Build reverse index from all reserve addresses
- Rejected: V4 Hub Supply uses underlying token which is shared with V3, causing ambiguous matches

## Consequences

- **Positive**: V3 and V4 campaigns are correctly segregated; no cross-version pollution
- **Positive**: Minimal memory cost (<10KB)
- **Positive**: Self-healing for future Merkl types (step 1 catches explicit V4; step 2 catches address-based)
- **Neutral**: `processMerklData()` now receives `baseDataset` parameter
- **Neutral**: `findMatchingMerklOpportunities()` now takes a `protocolVersion` filter parameter

## Superseded

This ADR's 4-step derivation and post-filtering approach has been superseded by **address-type-driven matching** (AAV-925, committed `1d5cbfc`).

### What changed

1. **Matching strategy**: `findMatchingMerklOpportunities` no longer uses `protocolVersion` parameter or post-filtering. Instead, V3 reserves query `[aToken, vToken]` and V4 reserves query `[underlying, spokeAddress]`. The address type itself determines version isolation — no post-filter needed.

2. **`deriveProtocolVersion` and `buildProtocolVersionLookup`**: Preserved (not removed). Still used by `processMerklData` for the index-building path where `protocolVersion` is assigned to each opportunity. The index-building path needs version info to set `opportunityData.protocolVersion`, even though the matching path no longer filters by it.

3. **spokeAddress added to V4 query list** (AAV-908 fix): V4 SPOKE_SUPPLY opps have spoke address as `explorerAddress`. Before this fix, spokeAddress was never queried, causing V4 spoke opps to never match any reserve.

### Preserved 4-step logic (for reference)

```
1. type starts with AAVE_V4_ → v4
2. Unambiguous address lookup → v3/v4
3. V4 underlying token lookup → v4
4. Default → v3
```

This logic remains active in `processMerklData` for `protocolVersion` assignment, but is no longer used for opp→reserve matching.