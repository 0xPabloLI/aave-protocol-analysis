---
alwaysApply: true
scene: all
---

# Project Rules - Aave Protocol Analysis

## Session Startup (Mandatory)

Every new session MUST follow this bootstrap sequence BEFORE any other action:

1. **Load `using-superpowers` skill** — Use the `Skill` tool to invoke `using-superpowers`
2. **Load `brainstorming` skill** — Use the `Skill` tool to invoke `brainstorming`
3. **Read `AGENTS.md`** — Review project-specific rules

This is mandatory. Do not skip even for simple questions.

## Why This Matters

- `using-superpowers` establishes the discipline of checking skills before any action
- `brainstorming` ensures creative work follows a design-first process
- `AGENTS.md` contains project-specific architecture and safety rules

## Data Validity Rule (Critical)

**When proposing ANY code change involving blockchain numerical values, you MUST cross-check against actual data files before making the recommendation.**

Specifically:

1. **`raw` vs `value` are NOT interchangeable**:
   - `amount.raw` = on-chain base units (includes decimals, e.g. `"7000000000000000000000000"` for 7M tokens with 18dp)
   - `amount.value` = human-readable units (decimal-applied, e.g. `"7000000"`)
   - Checking `raw === "1"` means "1 wei" (10^-18), NOT "1 token"
   - Checking `value === 1` means "1 whole token"

2. **Always verify assumptions against `data/debug/` files** before suggesting:
   - Unit conversions between raw/value/usd
   - Arithmetic operations (subtraction, comparison, clamping)
   - Condition checks on token amounts (e.g. "is supplyCap disabled?")

3. **If you're unsure about decimal semantics, read the actual debug data first.**

Example of a wrong assumption caught by this rule:
> ❌ *"`supplyCapIsOne` could be `supplyCap === '1'` using raw"* — WRONG: raw includes decimals. For a token with 18dp, raw="1000000000000000000" ≠ "1", but value="1" is correct.
> ✅ `toFiniteNumber(supplyCapValue) === 1` — correct: value already has decimals applied.

## Enforcement

If you (the AI) have not completed the bootstrap sequence, STOP and do it now.
Do not proceed with user requests until these skills are loaded.

## Deployment Safety Rule (Critical)

**Before executing ANY Railway deploy command (`railway up`, `railway deploy`, `railway redeploy`), you MUST:**

1. **Run `railway status` first** and verify the linked service
2. **Check the target service matches the intent**:
   - `aave-protocol-analysis` = app → OK to `railway up`
   - `Postgres-mDWG` = database → **NEVER use `railway up`**, only `railway redeploy --from-source`
3. **If linked service is wrong**, use `railway link --service <correct-service>` first

**Why this matters (real incident: 2026-05-10):**
- Running `railway up` while linked to `Postgres-mDWG` replaced the PostgreSQL template
  container with a Node.js app build, causing a multi-hour database outage
- Data was safe on the persistent volume but the service was down until recovered
- `railway redeploy` without `--from-source` inherits the corrupted manifest

This is a **hard gate** — do not skip even if the user says "just deploy."

## Frontend Cache Invalidation Rule (Critical)

### Dual-Fingerprint Mechanism

The frontend uses **two complementary fingerprints** for cache invalidation:

| Mechanism | Location | Trigger | Scope |
|---|---|---|---|
| `SCHEMA_FP` | `aaveapy/src/shared/schema-fingerprint.ts` | Frontend deploy (baked into bundle) | Immediate on page load |
| `CACHE_VERSION` | `aaveapy/src/lib/cache.ts` | Manual bump | Non-schema reasons |
| `meta.schemaFingerprint` | Backend API response → frontend `fetchMarkets()` | Runtime drift detection | Lazy (on next cache access) |

### When to bump CACHE_VERSION

`SCHEMA_FP` handles API shape changes automatically — when the backend schema fingerprint changes, sync it to the frontend via manual copy (see Workflow below). `CACHE_VERSION` is for non-schema reasons only:

| Reason | Example |
|---|---|
| Value format change (same schema) | APY from ratio → percent |
| Data fix requiring cache purge | Incorrect prices shipped |
| Cached data semantics changed | Same field, different meaning |

### Schema Fingerprint Sync Workflow

```
Backend build → gen:schema-fp computes SCHEMA_FP
  ↓
Manual copy to aaveapy/src/shared/schema-fingerprint.ts
  ↓
Both repos deployed independently
  ↓
Frontend deploy → effectiveFp changes → old cache invalidated immediately
Backend deploy → meta.schemaFingerprint updates → drift detection on next API call
```

## Schema Design Principle: No Redundant Columns

**When designing a DB table that contains a JSONB column with structured data, for EVERY proposed outer column, ask:**

> "Is this value already present inside the JSONB? If so, does the DB need to query/filter/sort/update it independently?"

If the answer to the second question is **no**, the column belongs in JSONB, not as an outer column.

### Decision framework

| Column usage | Put in outer column | Keep in JSONB |
|---|---|---|
| DB queries / filters / range scans against it | ✅ Yes (B-tree index needed) | ❌ No |
| DB updates it every cycle (e.g. `last_seen_at`) | ✅ Yes (efficient UPDATE) | ❌ No |
| Read-only, only consumed by frontend / API layer | ❌ Redundant | ✅ Yes |
| Semantic duplicate of a JSONB field | ❌ Redundant | ✅ Already there |

### Why this matters (real incident: 2026-05-17)

`campaign_history` table design initially had `is_expired`, `expired_at`, and `first_seen_at` as outer columns alongside `campaign_data` JSONB. All three were either semantically derivable from JSONB fields (`endDate`/`startDate`/`campaignEndedAt`) or expressible via `last_seen_at` window queries. Only `last_seen_at` needed to be an outer column because it's updated every cron cycle and used in range queries. The other three columns were eliminated.

### Enforcement

When reviewing a schema design, challenge every non-JSONB column. The default answer should be "keep it in JSONB" unless there's a concrete query/update need for an outer column.
