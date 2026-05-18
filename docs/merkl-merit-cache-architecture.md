# Merkl / Merit Data Flow & Cache Architecture

Last updated: 2026-04-09 (compressed overview)

This document explains how Merkl + Merit data moves through the codebase, which files are for debugging vs runtime, and which caches are in memory.

## 0) Cache Taxonomy

One data set can pass through more than one layer. The terms below describe the role, not just the implementation.

| Type | What it is | Scope | Writes | Reads | Example |
|---|---|---|---|---|---|
| Pure in-memory cache | Small keyed cache for repeated sub-results | One process | Lazy/on demand | Same process only | `metricsCache`, `tokenPriceResolveCache` |
| In-memory snapshot | Whole assembled state ready to serve | One process | Cron/startup refresh | API reads only | `snapshotCache`, `marketsService.snapshot` |
| Runtime bridge file | Compact file used to hand off data across processes or restarts | Disk + runtime | Root writer | Backend/root fallback | `data/runtime/merkl-opportunity-meta-lite.json` |
| Debug file | Verbose troubleshooting artifact | Disk + debug | Root writer | Humans/scripts | `data/debug/merkl-raw-data.json` |

## 1) Two Key Flows (Most Practical View)

### Arrow semantics (for the diagrams below)

- `-->` = function call / control flow
- `-- "reads" -->` = reads from file/cache
- `-- "writes" -->` = persists to disk
- `-. "fallback" .->` = fallback path only
- `-. "uses data" .->` = data dependency (not ownership/creation)

### C) Component responsibility / dependency view (no request timing)

```mermaid
flowchart LR
  IDX["packages/aave-fetcher/src/index.ts (orchestrator)"]
  MERKL["packages/aave-fetcher/src/merkl-api.ts (Merkl ingest + indexing)"]
  MERIT["packages/aave-fetcher/src/merit-api.ts (Merit ingest + mapping)"]
  SHARED["@internal/aave-shared-config (Merkl opportunities fetch/cache)"]
  MKS["backend/marketsService (internalized fetcher + memory snapshot)"]
  FCS["backend/merklForecastService (forecast compute + caches)"]
  MOC["backend/merklOpportunityClient (forecast Merkl opportunities fetcher)"]
  MKLITE["data/runtime/merkl-opportunity-meta-lite.json"]
  MARKETS["aave-formatted-data.full.json (root fetcher writes; backend does not read)"]
  TIMER["data/runtime/merit-campaign-metadata-cache.json"]
  MERKLAPI["Merkl API"]

  IDX --> MERKL
  IDX --> MERIT
  MERKL -. "uses data" .-> SHARED
  SHARED -. "uses data" .-> MERKLAPI
  MERKL -- "writes" --> MKLITE
   IDX -- "writes" --> MARKETS
  MERIT -- "writes" --> TIMER

  IDX -. "exports fetchMarketsData" .-> MKS
  FCS -- "reads" --> MKLITE
  FCS -. "uses data" .-> MOC
  MOC -. "uses data" .-> SHARED
  FCS -. "uses data" .-> MERKLAPI
```

### A) Producer flow (root fetcher writes runtime/debug files)

```mermaid
flowchart LR
  A["packages/aave-fetcher/src/index.ts runMarketsFetcher()"] --> B["packages/aave-fetcher/src/merkl-api.ts processMerklData()"]
  B --> C["@internal/aave-shared-config snapshot (raw opportunities[])"]
  C --> D["Merkl /v4/opportunities"]
  B -- "writes" --> E["data/runtime/merkl-opportunity-meta-lite.json"]
  B -- "writes" --> F["data/debug/merkl-raw-data.json"]
  A --> G["packages/aave-fetcher/src/merit-api.ts fetchMeritData()"]
  G -- "writes" --> H["data/runtime/merit-campaign-metadata-cache.json"]
  G -- "writes" --> I["data/debug/merit-raw-data.json"]
  G -- "writes" --> J["data/debug/merit-merkl-raw-data.json"]
   A -- "writes" --> K["data/debug/aave-formatted-data.full.json"]
```

### B) Forecast data path（公开入口：`/api/meta/side-data` → `forecast.items`）

**Cron-write, API-read-only pattern** (changed 2026-03-14):

```mermaid
flowchart LR
  subgraph CRON["Cron (every 10 min)"]
    C1["warmCampaignForecastStatesCache()"] --> C2["refreshForecastSnapshotCache()"]
    C2 --> C3["getMerklForecastState() per campaignId"]
    C3 --> C4["Merkl /v4/campaigns/{id}/metrics"]
    C4 --> C5["update global snapshotCache"]
  end

  subgraph API["API Request"]
    A1["forecast request"] --> A2["getForecastSnapshot()"]
    A2 --> A3{"snapshotCache exists?"}
    A3 -- yes --> A4["return cached snapshot"]
    A3 -- no --> A5["return empty snapshot + warn"]
  end

  C5 -.-> A3
```

**Key change**: API requests **never** call Merkl API. They only read from the global snapshot cache populated by cron.

**Field lineage** (which values come straight from Merkl vs computed in `merklForecastService` / `merklForecastModel`): see `docs/api/api-documentation.md` → **Merkl Forecast：上游数据与派生字段**.

## 2) Big Picture (Backend)

```mermaid
flowchart TD
  A["Root CLI: runMarketsFetcher()"] --> B["packages/aave-fetcher/src/index.ts pipeline"]
  B --> C["Merit: packages/aave-fetcher/src/merit-api.ts"]
  B --> D["Merkl: packages/aave-fetcher/src/merkl-api.ts"]
  B --> E["Brevis"]
  C --> F["data/debug/merit-raw-data.json"]
  C --> G["data/debug/merit-merkl-raw-data.json"]
  C --> H["data/runtime/merit-campaign-metadata-cache.json"]
  D --> I["data/debug/merkl-raw-data.json (debug)"]
  D --> J["data/runtime/merkl-opportunity-meta-lite.json (runtime-lite)"]
  D --> R["@internal/aave-shared-config snapshot (memory)"]
   B --> K["data/debug/aave-formatted-data.full.json"]
  CRON["Backend cron: refreshMarketsSnapshot"] --> MP["fetchMarketsData() same pipeline, in-memory"]
  MP --> MS["marketsService memory snapshot"]
  L["backend GET /api/markets"] --> MS
  N["backend /api/meta/side-data (forecast.items)"] --> O["merklForecastService"]
  O --> P["campaignOpportunityCache (memory)"]
  O --> J
  O --> Q["merklOpportunityClient"]
  Q --> R
  R --> S["Merkl /v4/opportunities"]
  O --> T["Merkl /v4/campaigns/{id} + /metrics"]
```

## 3) File Responsibilities (Disk)

### Runtime-facing (program reads)
- `data/runtime/merkl-opportunity-meta-lite.json`
  - Forecast service preferred file source (campaign-level lightweight meta)
- `data/runtime/merit-campaign-metadata-cache.json`
  - Merit campaign metadata cache (time ranges/message/link) for `fetchMeritData()`

### Debug / Troubleshoot (human-facing first)
- `data/debug/aave-formatted-data.full.json`
  - Written when the **root** fetcher runs (`runMarketsFetcher` / CLI); not read by `GET /api/markets`. The backend serves markets from `marketsService` memory via `fetchMarketsData()` (same pipeline, no file read on the request path).
- `data/debug/merkl-raw-data.json`
  - Full Merkl debug snapshot (raw/live opportunities + processed/index)
- `data/debug/merit-raw-data.json`
  - Merit APR raw + campaignMetadataByKey + built index
- `data/debug/merit-merkl-raw-data.json`
  - Merit last-round reward estimation debug (Merkl JSON_AIRDROP history scan)
- `data/debug/brevis-raw-data.json`
  - Brevis debug snapshot

### Merkl / Merit focused caches

- `marketsService.snapshot`: in-memory markets snapshot, read by `GET /api/markets`
- `campaignOpportunityCache`: per-forecast campaign meta index, rebuilt on demand
- `snapshotCache`: cron-written forecast response snapshot for `GET /api/meta/side-data`
- `metricsCache`: per-campaign Merkl metrics cache, dynamic TTL by cadence
- `@internal/aave-shared-config` snapshot cache: shared raw opportunities cache for root/backend fallback
- `meritRoundEstimateCache`: per-key Merit history estimate cache
- `meritCampaignMetadataMemoryCache` + `data/runtime/merit-campaign-metadata-cache.json`: in-memory + runtime bridge for Merit metadata

### Other runtime caches

- `tokenPriceResolveCache`: short-lived token price memoization
- `coingeckoPlatformCache`: CoinGecko platform-id lookup cache

### Token price lineage

```mermaid
flowchart TD
  A["Aave markets data"] --> B["baseDataset.item.tokenPrice"]
  B --> C["buildReserveTokenPriceMap()"]
  C --> D["resolveUsdPriceWithPriority()"]
  D --> E["Merkl totalBudget"]
  D --> F["Brevis totalBudget"]
  B --> G["fetchMarketsData()"]
  G --> H["backend marketsService snapshot"]
  H --> I["GET /api/markets"]
```

`tokenPriceResolveCache` only memoizes price lookups inside the root pipeline; it does not replace the Aave-sourced `reserve.tokenPrice` that is later exposed through `GET /api/markets`.

### How the layers relate

1. Root fetcher may write a runtime bridge file.
2. Backend may read that file once and turn it into an in-memory cache.
3. API endpoints usually read only the in-memory snapshot/cache.
4. Expensive sub-requests use per-key in-memory caches.

### Why the split exists

- In-memory cache: avoids repeated work inside one process
- In-memory snapshot: serves a complete response without recomputing it
- Runtime bridge file: survives restart and enables root/backend handoff

### Fileability status

| Status | Meaning | Examples |
|---|---|---|
| 已文件化 | 现在已经依赖 runtime file / disk artifact | `data/runtime/merkl-opportunity-meta-lite.json`, `data/runtime/merit-campaign-metadata-cache.json` |
| 适合文件化但未实现 | 重启后希望保留上次可用结果，且结果天然是整块快照 | `GET /api/markets` full snapshot, `GET /api/meta/side-data` forecast snapshot |
| 不适合文件化 | 细粒度、短生命周期、或重建成本很低 | `metricsCache`, `tokenPriceResolveCache`, `coingeckoPlatformCache` |

Rules of thumb:

1. If restart recovery matters, runtime file or external storage is required.
2. If the data is keyed and hot-path only, keep it in memory.
3. If the data is an assembled response, file it only when restart recovery is worth the extra complexity.

### What is documented elsewhere

- Field-level Merkl mapping: `docs/api/api-documentation.md`
- TTL and freshness policy: `docs/backend/data-freshness-mechanism.md`
- Reusable cache patterns: `docs/reusable/caching-data-freshness-patterns.md`

## 4) Terminology

- **Persist to disk / 落盘**: write a JSON snapshot file to disk
- **Snapshot**: point-in-time cached data copy
- **Index (runtime index)**: compact structure optimized for lookups (e.g. `campaignId -> meta`)
- **Raw / debug snapshot**: larger multi-purpose JSON for troubleshooting or audits

## 5) Recommended Next Steps (Planned / Optional)

1. Keep `merkl-raw-data.json` as debug-first file; no urgent slimming required now that runtime prefers lite file.
2. Optionally prewarm forecast caches at backend startup or scheduler tick to reduce first-request latency.
3. If moving to multi-replica, promote shared cache/storage (e.g. Redis) before treating local files as the primary runtime source.
