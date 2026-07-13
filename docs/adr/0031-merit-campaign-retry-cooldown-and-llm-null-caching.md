# ADR-0031: Merit Campaign Retry Cooldown and LLM Null Caching

**Status**: Implemented
**Date**: 2026-06-21
**Commit**: `1d5cbfc`

## Context

Two infinite retry loops were consuming Cloudflare Browser Rendering quota and LLM API time:

1. **Merit ended campaign infinite retry**: `fetchAllMeritTimeRanges()` marks ended campaigns as `needsUpdate=true` to detect renewed rounds. But when a campaign truly ends (no new round), even a successful refetch returns the same past `endDate` → `cachedCampaignEnded` stays `true` → refetch every ~3min cycle forever. A single key (`ethereum-new-sgho-boost`) triggered 326 Worker requests in one day, exhausting the Free plan's 10min/day browser quota.

2. **LLM null results not cached**: `detectNetPositionConstraint()` returns `null` when LLM is unavailable and regex also fails. This `null` was never written back to `cachedConstraints`, so every cycle re-invokes LLM. Logs show 331 `unavailable` outcomes per cycle, wasting ~3.5min on LLM timeouts.

Additionally, the Cloudflare Worker had two bugs amplifying quota consumption:
- Browser closed immediately after each request (`closeBrowser()` in `finally`), preventing reuse
- `maxLaunchesPerMinute=3` matches Free plan limit exactly with no safety margin

## Decision

### Merit retry cooldown

Add two timestamp fields to `MeritCampaignMetadataEntry`:
- `lastCheckedAt`: set after successful fetch. If `cachedCampaignEnded && lastCheckedAt` is within 6 hours, skip retry.
- `failedAt`: set after failed fetch. If `failedAt` is within 30 minutes, skip retry.

```
needsUpdate = !completeness.isComplete || (cachedCampaignEnded && !withinRetryCooldown && !withinEndedRecheck)
```

### LLM null caching

Change `cachedConstraints` value type from `Map<string, NetPositionConstraint>` to `Map<string, NetPositionConstraint | null>`. Use `!== undefined` (vs truthy) to distinguish:
- `undefined` → key not in map → never checked → proceed to LLM
- `null` → key exists with null value → already checked, no result → skip LLM
- `NetPositionConstraint` → already checked with result → skip LLM

Write `null` results back to `cachedConstraints` immediately, and persist them in payload via `extractConstraintMap` using `'netPositionConstraint' in group` detection.

### Worker fixes

- Replace `await this.closeBrowser()` with `this.scheduleIdleClose()` in request `finally` block
- Reduce `defaultMaxIdleMs` from 600000 (10min) to 120000 (2min) — short window for reuse without over-consuming quota
- Reduce `maxLaunchesPerMinute` from 3 to 2 — safety margin below Free plan limit

## Consequences

- **Merit ended campaigns**: at most 1 fetch per 6 hours (successful) or 30 minutes (failed), instead of every ~3 minutes
- **LLM null caching**: first cycle detects null, all subsequent cycles skip LLM call. Trade-off: if LLM later becomes available, null results won't be re-evaluated until the cache entry is evicted (by `shrinkCampaignMetadataCache`) or a new cycle starts without a prior null in `cachedConstraints`.
- **Worker**: browser instances live up to 2min after last request, enabling reuse for closely-spaced requests. `maxLaunchesPerMinute=2` leaves margin to avoid 429.
