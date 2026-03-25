# Redundant fields, storage, and calculations — audit

**Purpose**: Inventory of redundant or partially redundant fields, cache metadata, and duplicate logic across the fetcher, Merkl forecast pipeline, and runtime payloads. Intended for engineering review (e.g. Codex) before cleanup PRs.

**Scope**: Root fetcher (`src/`), backend Merkl forecast (`backend/src/services/merklForecast*`, `merklForecastController`), and `merkl-opportunity-meta-lite` / reserve pruning. Does not claim to cover every file in the repo.

**Last updated**: 2025-03-25

---

## 1. Merkl forecast model and API (`merklForecastModel`, `merklForecastService`, `toForecastResponseItem`)

### 1.1 Computed but never read (dead output)

| Item | Location | Notes |
|------|----------|--------|
| **`expectedByNow`** | `buildForecastState()` in `backend/src/services/merklForecastModel.ts` | Linear “expected distribution by now” is computed and stored on `MerklForecastState`. No other module reads it. `toForecastResponseItem` does not expose it. Unit tests do not assert it. |

### 1.2 Passed through, not used in formulas

| Item | Notes |
|------|--------|
| **`computedUntil`** | Taken from `campaignStatus.computedUntil` / snapshot, stored on `MerklForecastState`. Does not feed `plannedDaily`, `requiredDaily`, `distributedSoFar`, or any other calculation. |

### 1.3 In model output but not used inside `buildForecastState` math

| Item | Notes |
|------|--------|
| **`latestTvl`** | Normalized and returned on state; **not** used in any formula inside `buildForecastState`. Forecast HTTP responses **do** include `latestTvl`, so it is not dead for API consumers—only “unused inside the model’s math.” |

### 1.4 Full state vs HTTP response

`getMerklForecastState()` returns full `MerklForecastState`. `toForecastResponseItem()` maps only: `campaignId`, `campaignType`, `plannedDaily`, `requiredDaily`, `aprCap`, `totalBudget`, `distributedSoFar`, `latestTvl`, `endTimestamp`.

Fields such as **`remainingBudget`**, **`remainingDays`**, **`asOf`**, **`startTimestamp`**, **`computedUntil`**, **`expectedByNow`** are either omitted or only exist on the internal object. Some of these (**`remainingBudget` / `remainingDays`**) **are** used internally to derive **`requiredDaily`** (non–DUTCH paths); they are not “dead,” only not exposed on the public forecast JSON.

---

## 2. Merkl metrics cache (`backend/src/services/merklForecastService.ts`)

### 2.1 Cache entry fields written but never read on hit

`MetricsCacheEntry` stores `ttlMs` and `cadenceSeconds` when populating `metricsCache`. `getCachedOrFetchMetrics` only uses **`cached.data`** and **`cached.expiresAt`** when serving a cache hit; **`ttlMs`** and **`cadenceSeconds`** are not read afterward.

**Implication**: Extra memory per campaign; no behavioral effect today. If nothing else (logging, metrics, future persistence) reads them, they are redundant on the entry object.

### 2.2 Trimmed metrics vs opportunity TVL

`trimMetricsForForecast` sorts `tvlRecords` and keeps a single latest point. `getMerklForecastState` sets:

`latestTvl = campaignOpportunityMeta?.tvl ?? extractLatestTvl(metrics)`.

When opportunity metadata always supplies TVL (normal path), **`extractLatestTvl(metrics)`** and the retained **`tvlRecords`** slice are mostly **fallback / defensive**—easy to mistake for duplicate work.

---

## 3. Lite file and in-memory opportunity meta

### 3.1 `data/runtime/merkl-opportunity-meta-lite.json` (and embedded campaign snapshots)

| Field | Notes |
|-------|--------|
| **`campaignSnapshot.campaignStatus.computedUntil`** | Persisted in lite snapshots. Forecast math does not use it; public forecast JSON does not expose it (see §1). |
| **`distributionTypeRaw`** | Stored next to **`campaignTypeHint`**. Backend forecast logic uses **`campaignTypeHint`** only; **`distributionTypeRaw`** is never read in code paths reviewed for this audit. |

### 3.2 Root fetcher alignment

`src/merkl-api.ts` builds the same conceptual meta (`buildForecastCampaignMetaLiteMap`, `distributionTypeRaw`, `computedUntil` on snapshot) for the lite file written by the root fetcher.

---

## 4. Root fetcher: duplicate business logic (maintainability, not “unused export”)

| Area | Notes |
|------|--------|
| **Budget normalization** | `buildForecastFieldsFromOpportunity` in `src/merkl-api.ts` mirrors the intent of **`extractNormalizedTotalBudget`** in `backend/src/services/merklForecastService.ts` (comment in source references the backend). Two places to update if rules change. |

---

## 5. `distributionType` on Merkl breakdowns vs runtime prune

`processMerklData` assigns **`distributionType`** on each breakdown. **`pruneMerklBreakdownForRuntime`** in `src/index.ts` does **not** copy **`distributionType`** into the runtime reserve payload.

**Implication**: The field is not present on **`/api/markets`** reserve rows as shaped by prune. If nothing else consumes it before prune, it does not affect the public runtime API surface (may still help debugging or future use on non-pruned paths).

---

## 6. Intentionally not “redundant” (architecture)

| Topic | Notes |
|-------|--------|
| **Root `data/runtime/*.json` vs backend** | Backend serves markets from in-memory snapshot from cron; it does not read root fetcher JSON for `/api/markets`. On-disk artifacts are for exports/debug; not redundant logic. |
| **`remainingBudget` / `remainingDays`** | Used inside `buildForecastState` to compute **`requiredDaily`** for non–DUTCH campaigns—not dead variables. |

---

## 7. Suggested cleanup directions (for review)

Priority is subjective; align with product/API contracts before deleting fields.

1. **Remove or stop computing `expectedByNow`** unless a consumer (API, tests, or ops) will use it.
2. **Slim `MetricsCacheEntry`**: drop stored **`ttlMs` / `cadenceSeconds`**, or log **`cadenceSeconds`** once when refreshing cache instead of retaining on the entry.
3. **Lite file**: stop persisting **`computedUntil`** and/or **`distributionTypeRaw`** if no external reader or debugging workflow depends on them.
4. **Shared module**: factor **normalized total budget** (and related decimal/price rules) into a small shared helper used by both `merkl-api` and `merklForecastService` to avoid drift.
5. **Breakdown `distributionType`**: if runtime API will never expose it, consider avoiding attaching it to objects that are only consumed after prune (reduces confusion only—behavior unchanged).

---

## 8. References in repo

- Forecast response shaping: `backend/src/controllers/merklForecastController.ts` (`toForecastResponseItem`).
- Internal state vs REST: `docs/api/api-documentation.md` (Merkl forecast / `MerklForecastState` notes).
- Cache layers: `docs/merkl-merit-cache-architecture.md`, `docs/backend/data-freshness-mechanism.md`.

---

## 9. Review checklist for Codex / reviewers

- [ ] Confirm no external system parses `merkl-opportunity-meta-lite.json` fields slated for removal.
- [ ] Confirm frontend/CLI does not rely on full `MerklForecastState` via a non-documented path.
- [ ] After any removal, run root + backend builds and existing tests (`merklForecastModel`, `merklForecastService`, Merkl-related tests).
