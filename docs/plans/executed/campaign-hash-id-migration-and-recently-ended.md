# Campaign Hash ID Migration + Recently Ended Embedding — Issue Breakdown

Source PRD: `docs/plans/prd-campaign-hash-id-migration-and-recently-ended-embedding.md`

## Slice 1: Campaign Hash ID Migration (Backend End-to-End) — ✅ DONE (90348a2)

### Parent
PRD: Campaign Hash ID Migration + Recently Ended Embedding

### What to build
Migrate `campaignId` field semantics from Merkl Database ID to Hash ID across all backend layers:
- `MerklCampaignBreakdown.campaignId` now stores Hash ID (hex string like `0x0cf07a3891...`)
- New optional `campaignDatabaseId?: string` for the single consumer that needs Database ID (fetchMerklCampaignDetails API call)
- All Map keys (`campaignDetailsCache`, `campaignAccessMap`, `amountVariantPriceMap`, `campaignSnapshotById`, `forecastCampaignMetaLite`) switch from Database ID to Hash ID
- Build `dbIdToHashId` mapping from `opp.campaigns` for breakdown database-id-to-hash lookup
- `fetchMerklCampaignDetails()` parameter renamed from `campaignId` to `databaseId`
- Backend serialization outputs `campaignId` (hash) + `campaignDatabaseId` (db id)
- Prune layer keeps both fields
- Test fixtures updated to hash format

### Acceptance criteria
- [x] `MerklCampaignBreakdown.campaignId` in shared-contracts stores Hash ID
- [x] `campaignDatabaseId?: string` added to `MerklCampaignBreakdown`
- [x] All Map keys in merkl-api.ts use Hash ID
- [x] `opp.campaigns` lookup uses `c.campaignId` (hash) instead of `c.id` (db)
- [x] `incentive-prune.ts` preserves both `campaignId` (hash) and `campaignDatabaseId`
- [x] `marketsApiSerialize.ts` serializes both fields (automatic via spread)
- [x] `EXPECTED_RUNTIME_FIELDS` not changed (campaignDatabaseId is optional, not in runtime fields)
- [x] Test campaignId values use hash-like format
- [x] `npm run ci:remote` passes
- [x] Dev server API verified: 69/74 hash IDs, 74/74 campaignDatabaseId present

### Blocked by
None — completed

---

## Slice 2: Remove PAST Opportunities Fetch — ✅ DONE (90348a2)

### Parent
PRD: Campaign Hash ID Migration + Recently Ended Embedding

### What to build
Remove the `status=PAST` fetch in `fetchMerklOpportunities()` (merkl-api.ts). This fetch grabs entire opportunities where all campaigns are expired, but per R2.6 these have no consumer after the recently-ended embedding moves to the frontend. The `allOpportunities` merge should just use `liveOpportunities`.

### Acceptance criteria
- [x] `status=PAST` fetch block removed from merkl-api.ts
- [x] `allOpportunities` only contains `liveOpportunities`
- [x] Related variables (`pastOpportunities`, `rawPast`, `liveIds`) cleaned up
- [x] `npm run ci:remote` passes

### Blocked by
Slice 1 (completed)

---

## Slice 3: Frontend Recently Ended Embedding + Campaign URL (aaveapy repo) — ✅ DONE (fbfe6474)

### Parent
PRD: Campaign Hash ID Migration + Recently Ended Embedding

### What to build
Embed recently ended campaign info into live campaign breakdowns by `rewardTokenSymbol` matching, replacing the standalone `RecentlyEndedSection` data flow. Add campaign-level Merkl URL to both live and ended campaign rows:
- Delete `recentlyEndedCampaigns.ts` entirely
- Add `recentlyEnded?` array to `IncentiveCampaign` interface (with `campaignUrl?`)
- Add `campaignUrl?: string` to `IncentiveCampaign` for Merkl campaign-level links
- In `buildIncentiveSources()`, partition Merkl breakdowns into live/ended, group ended by `rewardTokenSymbol`, attach matching ended breakdowns to live campaigns with `campaignUrl`
- Construct `campaignUrl = opportunity.link + '/campaigns/' + breakdown.campaignId` for Merkl campaigns
- `RecentlyEndedSection` reads from `campaign.recentlyEnded` instead of `collectRecentlyEndedCampaigns()`
- Each campaign row (live and ended) shows ExternalLink icon on right side when `campaignUrl` available
- Each ended item shows date range + `0.00%` + ExternalLink icon to Merkl campaign page
- Remove `campaignDatabaseId` from frontend `MerklCampaignBreakdown` type and schema
- Campaigns without Hash ID are discarded (cannot construct valid campaign URL)

### Acceptance criteria
- [ ] `recentlyEndedCampaigns.ts` and its test deleted
- [ ] `IncentiveCampaign` has `campaignUrl?` field
- [ ] `IncentiveCampaign` has `recentlyEnded?` field with `campaignUrl?` per item
- [ ] `buildIncentiveSources()` embeds ended breakdowns into live campaigns by `rewardTokenSymbol`
- [ ] `buildIncentiveSources()` constructs `campaignUrl` for Merkl campaigns
- [ ] Campaigns without Hash ID are discarded in `buildIncentiveSources()`
- [ ] `RecentlyEndedSection` reads from `campaign.recentlyEnded`
- [ ] ExternalLink icon appears on right side of each campaign row (live + ended) when `campaignUrl` available
- [ ] `MerklCampaignBreakdownSchema` and `MerklCampaignBreakdown` type have `campaignDatabaseId` removed
- [ ] Frontend build + tests pass
- [ ] Dev server API verified: campaign URLs render correctly

### Blocked by
Slice 4 (backend must remove `campaignDatabaseId` first for schema consistency)

---

## Slice 4: Backend Remove campaignDatabaseId (aave-protocol-analysis repo) — ✅ DONE (84836ab)

### Parent
PRD: Campaign Hash ID Migration + Recently Ended Embedding

### What to build
Remove `campaignDatabaseId` from the API schema across all backend layers. The field was added in Slice 1 to expose the Database ID alongside the Hash ID, but after grill-with-docs review, it's not needed by any frontend consumer:
- Frontend constructs campaign URLs using Hash ID + opportunity link (no Database ID needed)
- Backend internally retains `dbIdToHashId` Map for `/v4/campaigns/{databaseId}` API calls
- Database ID is never exposed in the API response

### What to change
1. `packages/aave-shared-contracts/src/index.ts`: Remove `campaignDatabaseId?: string` from `MerklCampaignBreakdown`
2. `packages/aave-fetcher/src/merkl-api.ts`: Remove `...(breakdownDbId !== hashId && { campaignDatabaseId: breakdownDbId })` and `...(cDbId && cDbId !== cHashId && { campaignDatabaseId: cDbId })` spread assignments
3. `packages/aave-fetcher/src/incentive-prune.ts`: Remove `campaignDatabaseId` passthrough line
4. `backend/src/types/index.ts`: Remove `campaignDatabaseId` from backend `MerklCampaignBreakdown` type
5. Update tests that assert `campaignDatabaseId` presence

### Acceptance criteria
- [ ] `campaignDatabaseId` removed from `MerklCampaignBreakdown` in shared-contracts
- [ ] `campaignDatabaseId` removed from breakdown/stub output in merkl-api.ts
- [ ] `campaignDatabaseId` removed from incentive-prune.ts
- [ ] `campaignDatabaseId` removed from backend types
- [ ] `dbIdToHashId` Map retained internally (used for `/v4/campaigns/{databaseId}` API calls)
- [ ] `npm run ci:remote` passes
- [ ] Dev server API verified: `campaignDatabaseId` no longer in response

### Blocked by
Slice 1 (completed)

---

## Slice 5: Merkl URL Simplification (both repos)

### Parent
PRD: Campaign Hash ID Migration + Recently Ended Embedding

### What to build
Merkl has simplified their URL format from `/opportunities/{chain}/{type}/{identifier}` to `/opportunities/{oppId}`. Campaign URLs follow `/opportunities/{oppId}/campaigns/{hash}`. This allows:
- Backend to stop generating full Merkl opportunity links — just expose `opportunityId`
- Frontend to construct all Merkl URLs from `opportunityId` + `campaignId`
- Remove `opportunityType` from API output (backend-only field)

### What to change

**Backend:**
1. `packages/aave-shared-contracts/src/index.ts`: Add `opportunityId?: string` to `MerklOpportunityGroup`
2. `packages/aave-fetcher/src/merkl-api.ts`: Populate `opportunityId` from `opp.id`; stop calling `generateMerklOpportunityLink()` for Merkl groups; output `link: undefined` for Merkl
3. `packages/aave-fetcher/src/incentive-prune.ts`: Add `opportunityId` passthrough; remove `opportunityType` passthrough for Merkl
4. `backend/src/types/index.ts`: Add `opportunityId`; remove `opportunityType` from Merkl group type

**Frontend:**
1. `src/components/dashboard/IncentiveTooltip.tsx`: Replace `getMerklLink()` with `opportunityId`-based URL construction (`https://app.merkl.xyz/opportunities/${opportunityId}`); update `campaignUrl` construction; remove `opportunity.link` dependency for Merkl
2. `src/shared/market-contract/schemas.ts`: Add `opportunityId`; remove `opportunityType`
3. `src/types/aave.ts`: Add `opportunityId`; remove `opportunityType`

### Acceptance criteria
- [ ] `opportunityId` present on Merkl opportunity groups in API response
- [ ] Merkl groups no longer have `link` field populated
- [ ] `opportunityType` no longer in API output for Merkl groups
- [ ] Frontend constructs opportunity URL as `https://app.merkl.xyz/opportunities/${opportunityId}`
- [ ] Frontend constructs campaign URL as `https://app.merkl.xyz/opportunities/${opportunityId}/campaigns/${campaignId}`
- [ ] `getMerklLink()` helper removed from IncentiveTooltip.tsx
- [ ] Merit/Brevis `link` fields unaffected
- [ ] `npm run ci:remote` passes (backend)
- [ ] Frontend build + tests pass
- [ ] Playwright verification: Merkl campaign ExternalLink icons navigate to correct URLs

### Blocked by
Slice 3 + Slice 4 (completed)
