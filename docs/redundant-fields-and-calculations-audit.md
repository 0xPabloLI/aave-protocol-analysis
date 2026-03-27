# Redundant fields, storage, and calculations — audit

**Purpose**: Inventory of redundant or partially redundant fields, cache metadata, and duplicate logic across the fetcher, Merkl forecast pipeline, and runtime payloads. Intended for engineering review (e.g. Codex) before cleanup PRs.

**Scope**: Root fetcher (`src/`), backend Merkl forecast (`backend/src/services/merklForecast*`, `merklForecastController`), and `merkl-opportunity-meta-lite` / reserve pruning. Does not claim to cover every file in the repo.

**Last updated**: 2026-03-26

---

## 1. Merkl forecast model and API (`merklForecastModel`, `merklForecastService`, `toForecastResponseItem`)

### 1.1 In model output but not used inside `buildForecastState` math

| Item | Notes |
|------|--------|
| **`latestTvl`** | Normalized and returned on state; **not** used in any formula inside `buildForecastState`. Current forecast endpoint (`/api/campaigns/forecast-states`) does **not** expose it. It remains useful via `/api/markets` Merkl breakdown fields (opportunity-only forecast fields). |

### 1.2 Full state vs HTTP response

`getMerklForecastState()` returns full `MerklForecastState`. `toForecastResponseItem()` currently maps only: `campaignId`, `requiredDaily`, `distributedSoFar`, `endTimestamp`.

Fields such as **`campaignType`**, **`plannedDaily`**, **`aprCap`**, **`totalBudget`**, **`latestTvl`**, **`remainingBudget`**, **`remainingDays`**, **`asOf`**, **`startTimestamp`** are omitted from forecast JSON. Some are still used internally (e.g. **`remainingBudget` / `remainingDays`** derive **`requiredDaily`** for non–DUTCH paths), and opportunity-only fields are intentionally served via `/api/markets` breakdowns for fresher cadence.

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
| **`campaignTypeHint`** | Required by backend forecast typing when loading lite snapshots (used as canonical campaign type). |
| **`campaignSnapshot`** | Optional fast path source for budget/time/APR-cap fields; when unavailable backend falls back to `GET /v4/campaigns/{id}`. |

### 3.2 Root fetcher alignment

`src/merkl-api.ts` builds the same conceptual meta (`buildForecastCampaignMetaLiteMap`, `campaignTypeHint`, `campaignSnapshot`) for the lite file written by the root fetcher.

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

1. **Slim `MetricsCacheEntry`**: drop stored **`ttlMs` / `cadenceSeconds`**, or log **`cadenceSeconds`** once when refreshing cache instead of retaining on the entry.
2. **Lite file schema**: keep minimal fields required by forecast (`tvl`, `campaignTypeHint`, optional `campaignSnapshot`) and avoid re-adding non-consumed metadata.
3. **Shared module**: factor **normalized total budget** (and related decimal/price rules) into a small shared helper used by both `merkl-api` and `merklForecastService` to avoid drift.
4. **Breakdown `distributionType`**: if runtime API will never expose it, consider avoiding attaching it to objects that are only consumed after prune (reduces confusion only—behavior unchanged).

---

## 8. References in repo

- Forecast response shaping: `backend/src/controllers/merklForecastController.ts` (`toForecastResponseItem`).
- Opportunity-only forecast fields on markets payload: `src/merkl-api.ts` (`buildForecastFieldsFromOpportunity`) + `src/index.ts` (`pruneMerklBreakdownForRuntime`).
- Internal state vs REST: `docs/api/api-documentation.md` (Merkl forecast / `MerklForecastState` notes).
- Cache layers: `docs/merkl-merit-cache-architecture.md`, `docs/backend/data-freshness-mechanism.md`.

---

## 9. Review checklist for Codex / reviewers

- [ ] Confirm no external system parses `merkl-opportunity-meta-lite.json` fields slated for removal.
- [ ] Confirm frontend/CLI does not rely on full `MerklForecastState` via a non-documented path.
- [ ] After any removal, run root + backend builds and existing tests (`merklForecastModel`, `merklForecastService`, Merkl-related tests).
