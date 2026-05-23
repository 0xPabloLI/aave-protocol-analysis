# Development Best Practices (Living Notes)

Last updated: 2026-03-27

General implementation and architecture practices. For detailed caching/TTL configuration, see `docs/backend/data-freshness-mechanism.md`. For Merkl/Merit data flow, see `docs/merkl-merit-cache-architecture.md`.

---

## 1) Naming & Modeling

- Prefer **reserve** over **pool** in code and UI naming for Aave reserve-level rows.
- Treat "display container" naming separately from protocol-level terminology; document the mapping.
- Normalize upstream naming only at boundaries (parsers/adapters), keep core domain names consistent.
- When Merkl and Brevis share the same response skeleton, reuse **shared structural types** (`BaseCampaignBreakdown`, `CampaignGroup<T>`) and generic traversal/serialization helpers; keep domain math and ingest-specific logic separate.

### Runtime payload shaping (lean output)

Data is built and enriched in `enrichDatasetWithIncentiveData()` which also handles nested field pruning inline (strips transient SDK fields from Merit/Merkl/Brevis sub-objects before writing to disk). There is no separate pruning pass — the single `RuntimeReserveData` type is the source of truth for both fetch output and API payload.

## 2) API Design

- Keep APIs separated by data granularity:
  - campaign-level forecast state（通过 `GET /api/meta/side-data` 的 `forecast.items` 暴露）
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

## 4) Frontend Data Loading & Cache Invalidation

- Use two layers:
  - in-memory query cache for current session UX
  - persistent local cache for refresh/reload resilience
- Expect two-phase UI updates (cached data first, fresh network data second).
- Do not duplicate heavy computation if UI can derive values from stable backend inputs.

### Cache Invalidation: Dual-Fingerprint Mechanism

The frontend cache (`aaveapy/src/lib/cache.ts`) uses two complementary fingerprints:

| Mechanism | Where | Trigger | Latency |
|---|---|---|---|
| `SCHEMA_FP` | `aaveapy/src/shared/schema-fingerprint.ts` (baked into bundle) | Frontend deploy | **Instant** (page load) |
| `meta.schemaFingerprint` | Backend API response → `fetchMarkets()` drift detection | Backend deploy | Lazy (next cache access) |
| `CACHE_VERSION` | `aaveapy/src/lib/cache.ts` | Manual bump | Next deploy |

`SCHEMA_FP` is a hash of all API response field names, computed by the backend build script (`backend/scripts/generate-schema-fp.ts`) and written to `packages/aave-shared-config/schema-fingerprint.ts`. When the API shape changes, the hash changes.

### How to Make a Schema Change Take Effect Immediately

When you change the backend API response shape and want frontend cache to invalidate on deploy:

```
1. Backend repo: npm run build (regenerates SCHEMA_FP)
2. Copy the new SCHEMA_FP value from:
     packages/aave-shared-config/schema-fingerprint.ts
   to:
     aaveapy/src/shared/schema-fingerprint.ts
3. Deploy both repos (order doesn't matter)
   - Backend: railway up
   - Frontend: vercel deploy
```

**Why manual copy?** Backend and frontend are independent deploy pipelines with no automatic cross-repo channel. The `meta.schemaFingerprint` field in the API response provides a safety net for users who haven't refreshed after a backend-only deploy, but the primary invalidation comes from the baked-in `SCHEMA_FP` in the frontend bundle.

**When to bump `CACHE_VERSION` instead:** Only for non-schema reasons that require a cache purge (value format change, data fix). Schema shape changes are handled by `SCHEMA_FP` automatically.

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
