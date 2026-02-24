# Merkl / Merit Data Flow & Cache Architecture

Last updated: 2026-02-24

This document explains how Merkl + Merit data moves through the codebase, which files are for debugging vs runtime, and which caches are in memory.

## 0) Two Key Flows (Most Practical View)

### Arrow semantics (for the diagrams below)

- `-->` = function call / control flow
- `-- "reads" -->` = reads from file/cache
- `-- "writes" -->` = persists to disk
- `-. "fallback" .->` = fallback path only
- `-. "uses data" .->` = data dependency (not ownership/creation)

### C) Component responsibility / dependency view (no request timing)

```mermaid
flowchart LR
  IDX["src/index.ts (orchestrator)"]
  MERKL["src/merkl-api.ts (Merkl ingest + indexing)"]
  MERIT["src/merit-api.ts (Merit ingest + mapping)"]
  SHARED["@internal/merkl-shared (Merkl opportunities fetch/cache)"]
  DFS["backend/dataService (/api/markets file cache)"]
  FCS["backend/merklForecastService (forecast compute + caches)"]
  MOC["backend/merklOpportunityClient (forecast Merkl opportunities fetcher)"]
  MKLITE["data/runtime/merkl-opportunity-meta-lite.json"]
  MARKETS["data/runtime/aave-formatted-data.json"]
  TIMER["data/runtime/merit-timeranges-cache.json"]
  MERKLAPI["Merkl API"]

  IDX --> MERKL
  IDX --> MERIT
  MERKL -. "uses data" .-> SHARED
  SHARED -. "uses data" .-> MERKLAPI
  MERKL -- "writes" --> MKLITE
  IDX -- "writes" --> MARKETS
  MERIT -- "writes" --> TIMER

  DFS -- "reads" --> MARKETS
  FCS -- "reads" --> MKLITE
  FCS -. "uses data" .-> MOC
  MOC -. "uses data" .-> SHARED
  FCS -. "uses data" .-> MERKLAPI
```

### A) Producer flow (root fetcher writes runtime/debug files)

```mermaid
flowchart LR
  A["src/index.ts fetchAaveMarketsData()"] --> B["src/merkl-api.ts processMerklData()"]
  B --> C["@internal/merkl-shared snapshot (raw opportunities[])"]
  C --> D["Merkl /v4/opportunities"]
  B -- "writes" --> E["data/runtime/merkl-opportunity-meta-lite.json"]
  B -- "writes" --> F["data/debug/merkl-raw-data.json"]
  A --> G["src/merit-api.ts fetchMeritData()"]
  G -- "writes" --> H["data/runtime/merit-timeranges-cache.json"]
  G -- "writes" --> I["data/debug/merit-raw-data.json"]
  G -- "writes" --> J["data/debug/merit-merkl-raw-data.json"]
  A -- "writes" --> K["data/runtime/aave-formatted-data.json"]
```

### B) Forecast request path (`/api/campaigns/forecast-states`)

```mermaid
flowchart LR
  A["forecast request"] --> B{"forecastCache hit?"}
  B -- yes --> Z["return cached forecast"]
  B -- no --> C["merklForecastService"]
  C --> D{"campaignOpportunityCache fresh?"}
  D -- yes --> E["use campaignOpportunityCache"]
  D -- no --> F{"runtime lite fresh? (<=60s)"}
  F -- yes --> G["build campaignOpportunityCache from lite file"]
  F -- no --> H["merklOpportunityClient"]
  H --> I["@internal/merkl-shared snapshot"]
  I -. "fallback" .-> J["Merkl /v4/opportunities (if snapshot miss)"]
  H --> K["opportunities[]"]
  K --> G
  E --> L["Merkl /v4/campaigns/{id}/metrics"]
  G --> L
  L --> MC["metricsCache (per campaign, dynamic TTL)"]
  MC --> M["build forecast state"]
  M --> N["write forecastCache"]
  N --> Z
```

## 1) Big Picture (Backend)

```mermaid
flowchart TD
  A["Scheduler / API-triggered refresh"] --> B["/src/index.ts fetchAaveMarketsData()"]
  B --> C["Merit: /src/merit-api.ts"]
  B --> D["Merkl: /src/merkl-api.ts"]
  B --> E["Brevis"]
  C --> F["data/debug/merit-raw-data.json"]
  C --> G["data/debug/merit-merkl-raw-data.json"]
  C --> H["data/runtime/merit-timeranges-cache.json"]
  D --> I["data/debug/merkl-raw-data.json (debug)"]
  D --> J["data/runtime/merkl-opportunity-meta-lite.json (runtime-lite)"]
  D --> R["@internal/merkl-shared snapshot (memory)"]
  B --> K["data/runtime/aave-formatted-data.json"]
  L["backend /api/markets"] --> M["dataService (memory cache)"]
  M --> K
  N["backend /api/campaigns/forecast-states"] --> O["merklForecastService"]
  O --> P["campaignOpportunityCache (memory)"]
  O --> J
  O --> Q["merklOpportunityClient"]
  Q --> R["@internal/merkl-shared snapshot (memory)"]
  R --> S["Merkl /v4/opportunities"]
  O --> T["Merkl /v4/campaigns/{id} + /metrics"]
```

## 2) File Responsibilities (Disk)

### Runtime-facing (program reads)
- `data/runtime/aave-formatted-data.json`
  - Main `/api/markets` source (via `dataService`)
- `data/runtime/merkl-opportunity-meta-lite.json`
  - Forecast service preferred file source (campaign-level lightweight meta)
- `data/runtime/merit-timeranges-cache.json`
  - Merit timeRanges/message cache for `fetchMeritData()`

### Debug / Troubleshoot (human-facing first)
- `data/debug/merkl-raw-data.json`
  - Full Merkl debug snapshot (raw/live opportunities + processed/index/tokenPrices)
- `data/debug/merit-raw-data.json`
  - Merit APR raw + timeRanges + built index
- `data/debug/merit-merkl-raw-data.json`
  - Merit last-round reward estimation debug (Merkl JSON_AIRDROP history scan)
- `data/debug/brevis-raw-data.json`
  - Brevis debug snapshot

## 3) In-Memory Caches (Runtime)

### A) `dataService` cache (`backend/src/services/dataService.ts`)
- Caches parsed `data/runtime/aave-formatted-data.json` for `/api/markets`
- Stale threshold (current): 60s

### B) `campaignOpportunityCache` (`backend/src/services/merklForecastService.ts`)
- Forecast-only campaign meta index:
  - `campaignId -> { tvl, campaignTypeHint, distributionTypeRaw, campaignSnapshot }`
- Rebuilt on demand when expired
- TTL (current): minute-level (default 60s), configurable independently from forecast result cache

### C) `forecastCache` (`backend/src/services/merklForecastService.ts`)
- Final forecast state cache by campaignId
- Stores computed result returned by `/api/campaigns/forecast-states`
- TTL (current): minute-level (default 60s), intentionally aligned with opportunity meta freshness

Example shape:
```ts
Map<string, {
  data: {
    campaignId: string;
    campaignType: 'MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE' | 'DUTCH_AUCTION' | 'FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE';
    plannedDaily: number;
    requiredDaily: number;
    totalBudget: number;
    distributedSoFar: number;
    latestTvl: number;
    aprCap: number | null;
    startTimestamp: number;
    endTimestamp: number;
    asOf: number;
  };
  expiresAt: number;
}>
```

### D) `metricsCache` (`backend/src/services/merklForecastService.ts`)
- Per-campaign cache for **forecast-trimmed** Merkl `/metrics` data (`dailyRewardsRecords`, `tvlRecords`, `aprRecords`)
- TTL is derived from observed metrics record cadence (with default/min/max bounds)
- Purpose: reduce `/metrics` request frequency while keeping `forecastCache` short-lived
- Current defaults:
  - default TTL: 30m
  - empty-record TTL: 5m
  - dynamic TTL clamp: 10m .. 6h

### E) `@internal/merkl-shared` snapshot cache (`packages/merkl-shared`)
- Caches **raw Merkl opportunities array** (not forecast-lite)
- Keyed by query params (`mainProtocolId/status/campaigns/itemsPerPage/...`)
- Used by root Merkl fetcher (`src/merkl-api.ts`) and backend forecast fallback (`backend/src/services/merklOpportunityClient.ts`)

Example shape:
```ts
Map<string, {
  data: unknown[];          // opportunities[]
  expiresAt: number;
  inFlight?: Promise<unknown[]>;
}>
```

### F) `meritRoundEstimateCache` (`src/merit-api.ts`)
- Per-key cache for Merit last-round reward estimates from Merkl JSON_AIRDROP history
- Key format: `${chainId}:${action}:${token}` (e.g. `42220:supply:usdt`)
- Current policy: check each key at most once per 24h

## 4) Merit: Why `loadCachedTimeRanges()` Exists

`fetchMeritData()` needs `timeRanges` because they carry:
- Merkl/Merit campaign link
- `startDate` / `endDate`
- `startBlock` / `endBlock` (fallback end-state signal)
- campaign `name`
- `message` (including self-auth hints)

Without cached `timeRanges`, the code would re-crawl campaign pages on every refresh.  
Now it uses a module-level in-memory cache first (process lifetime), then reads `data/runtime/merit-timeranges-cache.json`, then falls back to `data/debug/merit-raw-data.json` for compatibility.
This cache is intentionally event-driven (new key / refetch path / process restart) rather than TTL-driven.

## 5) Refresh Cadence vs Freshness (Important Pattern)

Two different concepts:

- **Write frequency (production frequency)** = how often a producer writes a file/snapshot
- **Freshness window (consumer tolerance)** = how old data can be before consumer rejects it

Example in current code:
- `merkl-opportunity-meta-lite.json` is written when root data refresh runs (often ~1m cadence)
- Forecast service accepts it if file timestamp is within **60s**

This decoupling makes the system tolerant to scheduler jitter and temporary delays.

## 6) Merit JSON_AIRDROP “Last Round” Check (Per-key 24h)

`fetchMeritRoundEstimates()` does **not** run as a standalone cron.  
It is called during `fetchMeritData()`, and then:
- builds target keys from current merit APR keys
- checks each key’s `lastCheckedAtMs`
- if any key is due, runs one Merkl history scan and stamps all current target keys together (`lastCheckedAtMs`)
- applies a short global scan cooldown (request coalescing / anti-stampede)

Notes:
- `lastCheckedAtMs` = **when we checked**, not “when data changed”
- Negative cache is used for misses (`estimate = null`), so keys that were checked but not found still record `lastCheckedAtMs`
- Key set can change across runs (new Merit incentives added, old ones removed)

## 7) Current Forecast Fallback Order (After recent refactor)

```mermaid
flowchart LR
  A["forecast request"] --> B{"campaignOpportunityCache fresh?"}
  B -- yes --> Z["return cached meta"]
  B -- no --> C{"merkl-opportunity-meta-lite.json fresh (<=60s)?"}
  C -- yes --> D["build campaignOpportunityCache from lite file"]
  C -- no --> E["merklOpportunityClient"]
  E --> F{"@internal/merkl-shared snapshot hit?"}
  F -- yes --> G["use cached opportunities[]"]
  F -- no --> H["call Merkl /v4/opportunities"]
  G --> I["build campaignOpportunityCache"]
  H --> I
```

(`merkl-raw-data.json` fallback for forecast has been removed.)

## 8) Terminology

- **Persist to disk / 落盘**: write a JSON snapshot file to disk
- **Snapshot**: point-in-time cached data copy
- **Index (runtime index)**: compact structure optimized for lookups (e.g. `campaignId -> meta`)
- **Raw / debug snapshot**: larger multi-purpose JSON for troubleshooting or audits

## 9) Recommended Next Steps (Planned / Optional)

1. Keep `merkl-raw-data.json` as debug-first file; no urgent slimming required now that runtime prefers lite file.
2. Optionally prewarm forecast caches at backend startup or scheduler tick to reduce first-request latency.
3. If moving to multi-replica, promote shared cache/storage (e.g. Redis) before treating local files as the primary runtime source.
