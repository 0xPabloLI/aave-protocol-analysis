# PRD: Campaign Hash ID Migration + Recently Ended Embedding

## Implementation Status

| Requirement | Status | Commit |
|---|---|---|
| R1: Campaign Hash ID Migration (Backend) | ✅ Done | 90348a2 |
| R2: Recently Ended Embedding (Frontend) | ✅ Done | fbfe6474 |
| R3: Remove PAST Opportunities Fetch | ✅ Done | 90348a2 |
| R4: Campaign URL + Remove campaignDatabaseId | ✅ Done | 84836ab (backend), fbfe6474 (frontend) |

## Summary

Two coupled changes: (1) Migrate `campaignId` from Merkl Database ID to Hash ID across the stack; (2) Embed recently ended campaign info into live campaign breakdowns by `rewardTokenSymbol` matching, replacing the standalone `RecentlyEndedSection` data flow. Additional follow-up: add campaign-level Merkl URL to both live and ended campaign rows, and remove `campaignDatabaseId` from the API schema (backend retains it internally for `/v4/campaigns/{databaseId}` API calls).

## Background

### Campaign ID Confusion
Merkl API has two IDs per campaign:
- `opp.campaigns[].id` = Database ID (numeric, e.g. `8109624644183159412`) — used as input to `/v4/campaigns/{dbId}`
- `opp.campaigns[].campaignId` = Hash ID (hex, e.g. `0x0cf07a3891db969d111ab99036b168b5965e6ada9054dfe5163197c6306ab265`) — used in Merkl web UI URLs: `https://app.merkl.xyz/opportunities/{oppId}/campaigns/{hash}`

Current codebase stores Database ID as `campaignId` everywhere. Frontend has no way to link to individual Merkl campaign pages. The naming is confusing because Merkl's own API calls the hash `campaignId`.

### Campaign-Level URL
Merkl supports campaign-level pages at `https://app.merkl.xyz/opportunities/{oppId}/campaigns/{hash}`. After the Hash ID migration, the frontend can construct these URLs using `opportunity.link` + `campaignId` (hash). This enables direct links to individual campaigns from both live and ended rows.

### Recently Ended Campaign Flow
Currently, ended campaigns are handled via a separate data flow:
- Backend creates "stubs" (minimal breakdowns with `campaignApr: 0`) from `opp.campaigns` and puts them in the same `breakdowns` array as live campaigns
- Frontend `collectRecentlyEndedCampaigns()` + `RecentlyEndedCampaign` interface + `isRecentlyEnded()` separately filters and displays ended campaigns in a collapsible section
- This separate flow means ended campaigns miss fields that live campaigns have (e.g. `rewardTokenSymbol`, `rewardTokenIconUrl`, `campaignType`)
- No reward-token-based association between ended and live campaigns exists

## Requirements

### R1: Campaign ID Migration (Backend + Frontend) — ✅ Done

**R1.1** `campaignId` field semantics changes from Database ID to Hash ID across all types in `@internal/aave-shared-contracts`, `@internal/aave-fetcher`, `backend`, and frontend.

**R1.2** ~~New optional field `campaignDatabaseId?: string` added to `MerklCampaignBreakdown`~~ → Removed in R4. Backend internally maintains `dbIdToHashId` Map for `/v4/campaigns/{databaseId}` API calls, but does not expose Database ID in the API schema.

**R1.3** All backend Map keys (`campaignDetailsCache`, `campaignAccessMap`, `amountVariantPriceMap`, `campaignSnapshotById`, `forecastCampaignMetaLite`) switch from Database ID to Hash ID as key.

**R1.4** `opp.campaigns?.find(c => String(c.id) === campaignId)` changes to `opp.campaigns?.find(c => String(c.campaignId) === campaignId)` (match by hash).

**R1.5** Frontend `IncentiveCampaign.campaignId` and `IncentiveSource` links automatically consume hash ID from backend. No frontend code needs to change its Map-key logic — it just works because the value is now hash.

**R1.6** Merkl campaign-level URL can be constructed on frontend: `https://app.merkl.xyz/opportunities/{oppId}/campaigns/{campaignId}` where `campaignId` is now hash. Opportunity link (`source.link`) provides the base URL; campaign URL = `source.link + '/campaigns/' + campaignId`.

### R2: Recently Ended Embedding (Frontend, backend already provides data)

**R2.1** Delete `RecentlyEndedCampaign` interface, `RecentlyEndedSource` interface, `collectRecentlyEndedCampaigns()` function, and `isRecentlyEnded()` function from `recentlyEndedCampaigns.ts`.

**R2.2** Delete `recentlyEndedCampaigns.ts` entirely (all exports removed).

**R2.3** Add to `IncentiveCampaign` interface:
```ts
recentlyEnded?: {
  startDate?: string;
  endDate: string;
  campaignId?: string;
  campaignUrl?: string;
}[];
```

**R2.4** In `buildIncentiveSources()`, for Merkl breakdowns:
- Partition each opportunity's breakdowns into live (`isCampaignActive`) and ended (`isRecentlyEnded` logic, i.e. `campaignEndedAt < now`)
- Group ended breakdowns by `rewardTokenSymbol`
- When building a live campaign from a breakdown, find ended breakdowns with matching `rewardTokenSymbol` and attach them as `recentlyEnded`
- Ended breakdowns that match a live campaign are NOT added as separate sources
- Campaigns without Hash ID are discarded (no valid campaign URL can be constructed)

**R2.5** `RecentlyEndedSection` component reads from `campaign.recentlyEnded` instead of `collectRecentlyEndedCampaigns()`. For each ended item: display date range + `0.00%` + ExternalLink icon to Merkl campaign page (if `campaignUrl` available).

**R2.6** No source-level fallback needed — backend `filterRecentExpiredCampaigns` skips opportunities where all campaigns are expired, so every ended breakdown will have a corresponding live breakdown in the same opportunity.

### R3: Remove PAST Opportunities Fetch — ✅ Done

**R3.1** Remove the `status=PAST` fetch in `fetchMerklOpportunities()`. This fetches entire opportunities where all campaigns are expired, but per R2.6 these have no consumer.

### R4: Campaign URL + Remove campaignDatabaseId

**R4.1** Add `campaignUrl?: string` to `IncentiveCampaign` interface. Constructed as `opportunity.link + '/campaigns/' + breakdown.campaignId` for Merkl campaigns.

**R4.2** Add ExternalLink icon to each campaign row (both live and ended) when `campaignUrl` is available. Icon positioned on the right side of the row, same line as APR value.

**R4.3** Remove `campaignDatabaseId` from API schema across all layers:
- `MerklCampaignBreakdown` type: remove `campaignDatabaseId?: string`
- `merkl-api.ts`: remove `...(breakdownDbId !== hashId && { campaignDatabaseId: breakdownDbId })` spread assignments
- `incentive-prune.ts`: remove `campaignDatabaseId` passthrough
- `marketsApiSerialize.ts`: automatically no longer serialized (field removed from type)
- Frontend `MerklCampaignBreakdownSchema`: remove `campaignDatabaseId`
- Frontend `MerklCampaignBreakdown` type: remove `campaignDatabaseId`

**R4.4** Backend internally retains `dbIdToHashId` Map for `/v4/campaigns/{databaseId}` API calls. Database ID is not exposed in the API response. `campaignDetailsCache` key = Hash ID; lookup by Database ID happens via `dbIdToHashId` before cache access.

**R4.5** Campaigns without Hash ID (fallback to Database ID in `campaignId`) are discarded at the point of `buildIncentiveSources()` — they cannot construct a valid campaign URL. In backend, these are already rare (~5% from old PAST cache, now near-zero after PAST fetch removal).

## Data Source Details

### Merkl v4 API `opp.campaigns[]` structure (verified 2026-06-29)
```json
{
  "id": 8109624644183159412,                    // Database ID
  "campaignId": "0x0cf07a3891db969d111ab9036b168b5965e6ada9054dfe5163197c6306ab265",  // Hash ID
  "startTimestamp": 1749124800,
  "endTimestamp": 1751548800,
  "distributionType": "DUTCH_AUCTION",
  "rewardToken": { "symbol": "aPlaGHO", "id": "..." },
  ...
}
```

### Merkl v4 API `/v4/campaigns/{databaseId}` response
```json
{
  "id": 8109624644183159412,          // Database ID (input param)
  "campaignId": "0x0cf07a...",         // Hash ID (in response)
  "startTimestamp": 1749124800,
  "endTimestamp": 1751548800,
  ...
}
```

### Opportunity Link Format
Backend constructs opportunity links from Merkl API data: `https://app.merkl.xyz/opportunities/{chainName}/{type}/{identifier}`. Frontend does not need to parse or reconstruct these links — it simply appends `/campaigns/{campaignId}` to construct campaign-level URLs.

### Campaigns Without Hash ID
After PAST fetch removal, campaigns without Hash ID are extremely rare (only when fallback `/v4/campaigns/{databaseId}` fetch also fails). These are discarded: no valid campaign URL can be constructed, and they have no consumer in the frontend.

## Affected Files

### Backend (aave-protocol-analysis repo)

| File | Change |
|---|---|
| `packages/aave-shared-contracts/src/index.ts` | Remove `campaignDatabaseId` from `MerklCampaignBreakdown`; update `EXPECTED_RUNTIME_FIELDS` if needed |
| `packages/aave-fetcher/src/merkl-api.ts` | Remove `campaignDatabaseId` from breakdown/stub output; retain `dbIdToHashId` internally |
| `packages/aave-fetcher/src/incentive-prune.ts` | Remove `campaignDatabaseId` passthrough |
| `packages/aave-fetcher/tests/filterRecentExpiredCampaigns.test.ts` | Remove `campaignDatabaseId` test assertions |
| `backend/src/types/index.ts` | Remove `campaignDatabaseId` from backend MerklCampaignBreakdown type |
| `backend/src/services/marketsApiSerialize.ts` | No longer serializes `campaignDatabaseId` (automatic via type removal) |

### Frontend (aaveapy repo)

| File | Change |
|---|---|
| `src/components/dashboard/IncentiveTooltip.tsx` | `IncentiveCampaign` add `campaignUrl?`, update `recentlyEnded?` to include `campaignUrl?`; `buildIncentiveSources` Merkl section: construct `campaignUrl`, partition live/ended, embed `recentlyEnded`; `RecentlyEndedSection` rewrite: read from `campaign.recentlyEnded`, add ExternalLink icons to both live and ended campaign rows; delete `RecentlyEndedCampaign`/`RecentlyEndedSource` imports |
| `src/lib/recentlyEndedCampaigns.ts` | Delete entire file |
| `src/lib/recentlyEndedCampaigns.test.ts` | Delete entire file |
| `src/shared/market-contract/schemas.ts` | `MerklCampaignBreakdownSchema`: remove `campaignDatabaseId` |
| `src/types/aave.ts` | `MerklCampaignBreakdown`: remove `campaignDatabaseId` |

## Risks

| Risk | Mitigation |
|---|---|
| Map key migration breaks forecast/whitelist logic | All maps already migrated in Slice 1 (90348a2); `campaignDatabaseId` removal is output-only |
| Hash ID format differs from existing test fixtures | Already updated in Slice 1 |
| Merkl API changes `opp.campaigns[].campaignId` field name | Low risk — stable v4 API; add runtime type check |
| `filterRecentExpiredCampaigns` dedup key uses `campaignId` | Already uses `rewardTokenId ?? rewardTokenSymbol ?? campaignType` as primary key; `campaignId` is fallback |
| Campaigns without Hash ID are silently discarded | Near-zero occurrence after PAST fetch removal; acceptable trade-off for clean API schema |

## Out of Scope

- Merit/Brevis recently ended campaigns (only Merkl for now)
- Removing `rewardTokenId` field (still used as dedup key)
- Moving opportunity link construction to frontend (backend retains — frontend only appends `/campaigns/{hash}`)
