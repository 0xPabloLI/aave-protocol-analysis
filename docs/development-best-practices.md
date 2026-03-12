# Development Best Practices (Living Notes)

Last updated: 2026-03-12

This is a living note for implementation and architecture practices we agreed on while iterating Merkl/Merit forecasting.

## 1) Data Freshness & Caching

- Separate **write frequency** (producer cadence) from **freshness window** (consumer tolerance).
- Before choosing a TTL, inspect the source data's real update cadence (API docs, observed timestamps, or sampled history) instead of guessing.
- If a cached result depends on multiple upstream sources, set TTL based on the freshest source that materially affects correctness (or split caches by source cadence).
- Prefer a layered fallback chain:
  1. in-memory runtime cache
  2. small runtime snapshot file
  3. online cached fetcher
  4. upstream API
- Use per-domain TTLs instead of forcing one global TTL.
- When source cadence is unknown, start conservative and instrument timestamps so TTL can be tuned from observed intervals.
- For expensive historical scans, use **negative cache** (record miss checks too).
- For user-decision APIs, add a **hard stale cap** beyond soft TTL (for example `/api/markets` > 5 minutes returns `503`) to avoid silently serving indefinitely stale snapshots.

## 2) File Snapshot Design

- Keep **runtime** and **debug/troubleshoot** snapshots separate.
- Runtime files should be small and purpose-built (example: `merkl-opportunity-meta-lite.json`).
- Debug files can be larger and more verbose, but should not sit on hot request paths.
- Write JSON snapshots with **atomic replace** (`tmp` + rename) to avoid partial reads.

## 3) Forecast API Design

- Keep APIs separated by data granularity:
  - campaign-level forecast state (`/api/campaigns/forecast-states`)
  - reserve/incentive-level market data (`/api/markets`)
- Put only fields needed for frontend forecasting into responses.
- Remove derivable fields from backend payloads when frontend can compute them cheaply.

## 4) Naming & Modeling

- Prefer **reserve** over **pool** in code and UI naming for Aave reserve-level rows.
- Treat “display container” naming separately from protocol-level terminology; document the mapping.
- Normalize upstream naming only at boundaries (parsers/adapters), keep core domain names consistent.

## 5) External API Integration

- Cache upstream responses at the narrowest useful layer.
- Keep a shared fetch utility generic (raw response caching) and move business-specific indexing outside it.
- Add lightweight debug metadata (request template, first page URL, pages scanned, cache hit flags) to raw snapshots for troubleshooting.
- Do not assume upstream sort flags (`order=desc`) mean "newest by business timestamp" unless the docs explicitly guarantee the sort field; verify empirically and compare timestamps in code when correctness depends on recency (for example Merkl `PAST + JSON_AIRDROP` opportunities).
- Scope empirical API-behavior notes to the exact endpoint + filter set tested (e.g. `PAST + JSON_AIRDROP`), and avoid over-generalizing to other statuses such as `LIVE`.
- When upstream lacks reliable time-based filtering, partition scans by known dimensions you control (for example target `chainId`) and record per-partition scan cost in debug output.
- Prefer empirically validated server-side filters that preserve correctness (for example `creatorSlug=aave` on Merkl `PAST + JSON_AIRDROP`) before adding more client-side scan complexity.
- When testing upstream query/filter behavior, **bypass or clear local caches first** (or explicitly prove cache bypass in logs/debug metadata).
  - For Merit round scans, confirm `hitCacheOnly=false` before trusting scan/page metrics.
  - `pagesScanned=0` with `hitCacheOnly=true` means no upstream scan happened.

## 6) Frontend Data Loading

- Use two layers:
  - in-memory query cache for current session UX
  - persistent local cache for refresh/reload resilience
- Expect two-phase UI updates (cached data first, fresh network data second).
- Do not duplicate heavy computation if UI can derive values from stable backend inputs.

## 7) Change Management

- Make refactors and behavior changes in separate commits when possible.
- Keep naming-only refactors isolated from logic changes.
- For architecture decisions that span multiple turns, update the docs in `docs/` as the durable source of truth.

## 8) Documentation & Workflow Enforcement

- Keep root docs minimal (`README.md`, `AGENTS.md`, contribution/security entry points).
- Move operational/reference topic docs into `docs/` by domain (`docs/backend`, `docs/deploy`, `docs/ops`, `docs/api`).
- Use `AGENTS.md` to point contributors/agents to the living architecture and best-practices notes before cache/data-flow changes.
- Treat code changes (atomic writes, runtime-lite snapshots, TTL/freshness split) as the strongest enforcement of agreed practices.

## 9) Pending/Watchlist

- Consider cache GC for obsolete Merit keys in `meritRoundEstimateCache`.
- Consider forecast cache prewarm if first-request latency becomes noticeable.
- Revisit local-file strategy before moving to multi-replica deployment (likely shared cache/store).

## 10) HTTP Cache Layering (Frontend staleTime + ETag + Cloudflare)

- Do not force one cache policy across all APIs.
- For user decision-critical APIs (markets, rate-inputs, forecast-states), prefer:
  - `Cache-Control: no-cache, must-revalidate`
  - `ETag` enabled
  - reasoning: frontend `staleTime` controls check interval; each check revalidates freshness while unchanged payloads return `304`.
- For slower side-data APIs (coingecko categories/fdv), prefer TTL-based headers with `s-maxage`.
- Keep Cloudflare rules aligned with endpoint classes:
  - bypass cache for realtime paths
  - edge-cache only side-data paths
- Detailed implementation/playbook lives in:
  - `docs/deploy/cloudflare-api-cache-playbook.md`
