# Development Best Practices (Living Notes)

Last updated: 2026-03-27

General implementation and architecture practices. For detailed caching/TTL configuration, see `docs/backend/data-freshness-mechanism.md`. For Merkl/Merit data flow, see `docs/merkl-merit-cache-architecture.md`.

---

## 1) Naming & Modeling

- Prefer **reserve** over **pool** in code and UI naming for Aave reserve-level rows.
- Treat "display container" naming separately from protocol-level terminology; document the mapping.
- Normalize upstream naming only at boundaries (parsers/adapters), keep core domain names consistent.
- When Merkl and Brevis share the same response skeleton, reuse **shared structural types** (`BaseCampaignBreakdown`, `CampaignGroup<T>`) and generic traversal/serialization helpers; keep domain math and ingest-specific logic separate.

### Runtime payload shaping (`prune*`)

Use **`prune`** for functions that **drop or whitelist fields** so objects match the **runtime / API / CSV** contract (not generic refactors).

- **Pattern**: `prune<Thing>ForRuntime` when the output is the shipped reserve payload or a nested fragment of it (examples in `src/index.ts`: `pruneReserveForRuntime`, `pruneMeritEntryForRuntime`, `pruneMerklGroupForRuntime`, `pruneMerklBreakdownForRuntime`).
- **Brevis**: `pruneBrevisCampaignForRuntime` in `src/brevis-api.ts` — removes transient `budget*` fields after `fetchBrevisAprs` enriches `totalBudget` (same “slim public shape” idea; may run before the final `pruneReserveForRuntime` pass).
- **Do not** introduce parallel verbs (`strip`, `omitForApi`, etc.) for the same role unless there is a clearly different semantic (e.g. security redaction); prefer extending the `prune*` family and documenting the call order in code comments.
- For grouped incentive payloads, prefer one generic serializer pass (for example `scaleGroupedCampaigns`) over parallel Merkl/Brevis loops that only differ in per-breakdown field scaling.

## 2) API Design

- Keep APIs separated by data granularity:
  - campaign-level forecast state (`/api/campaigns/forecast-states`)
  - reserve/incentive-level market data (`/api/markets`)
- Put only fields needed for frontend into responses.
- Remove derivable fields from backend payloads when frontend can compute them cheaply.

## 3) External API Integration

- Cache upstream responses at the narrowest useful layer.
- Keep a shared fetch utility generic (raw response caching) and move business-specific indexing outside it.
- Add lightweight debug metadata (request template, pages scanned, cache hit flags) to raw snapshots.
- Do not assume upstream sort flags (`order=desc`) mean "newest by business timestamp"; verify empirically.
- Scope empirical API-behavior notes to the exact endpoint + filter set tested.
- When testing upstream query/filter behavior, **bypass or clear local caches first**.

## 4) Frontend Data Loading

- Use two layers:
  - in-memory query cache for current session UX
  - persistent local cache for refresh/reload resilience
- Expect two-phase UI updates (cached data first, fresh network data second).
- Do not duplicate heavy computation if UI can derive values from stable backend inputs.

## 5) Change Management

- Make refactors and behavior changes in separate commits when possible.
- Keep naming-only refactors isolated from logic changes.
- For architecture decisions that span multiple turns, update the docs in `docs/` as the durable source of truth.

## 6) Documentation & Workflow

- Keep root docs minimal (`README.md`, `AGENTS.md`, contribution/security entry points).
- Move operational/reference docs into `docs/` by domain (`docs/backend`, `docs/deploy`, `docs/ops`, `docs/api`).
- Use `AGENTS.md` to point contributors to living architecture notes before cache/data-flow changes.

## 7) Pending/Watchlist

- Consider cache GC for obsolete Merit keys in `meritRoundEstimateCache`.
- Consider forecast cache prewarm if first-request latency becomes noticeable.
- Revisit local-file strategy before moving to multi-replica deployment.

---

## Related Documentation

| Topic | Document |
|-------|----------|
| TTL/Freshness configuration | `docs/backend/data-freshness-mechanism.md` |
| Merkl/Merit data flow | `docs/merkl-merit-cache-architecture.md` |
| API cache headers & Cloudflare | `docs/deploy/cloudflare-complete-guide.md` |
| Reusable patterns | `docs/reusable/` |
