# Development Best Practices (Living Notes)

Last updated: 2026-02-24

This is a living note for implementation and architecture practices we agreed on while iterating Merkl/Merit forecasting.

## 1) Data Freshness & Caching

- Separate **write frequency** (producer cadence) from **freshness window** (consumer tolerance).
- Prefer a layered fallback chain:
  1. in-memory runtime cache
  2. small runtime snapshot file
  3. online cached fetcher
  4. upstream API
- Use per-domain TTLs instead of forcing one global TTL.
- For expensive historical scans, use **negative cache** (record miss checks too).

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

## 8) Pending/Watchlist

- Consider cache GC for obsolete Merit keys in `meritRoundEstimateCache`.
- Consider forecast cache prewarm if first-request latency becomes noticeable.
- Revisit local-file strategy before moving to multi-replica deployment (likely shared cache/store).

