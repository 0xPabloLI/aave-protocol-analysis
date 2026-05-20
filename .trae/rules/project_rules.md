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

## Frontend Cache Version Bump Rule (Critical)

**When the backend API response schema changes in a way that makes old cached data incompatible, you MUST bump `CACHE_VERSION` in the frontend repo (`aaveapy/src/lib/cache.ts`).**

### Triggers (any one of these → bump required)

| Change type | Example |
|---|---|
| Field renamed or removed | `reserveSizeUsd` → deleted |
| Field value semantics changed | APY from ratio → percent |
| Field format changed | reserveId from name-based → address-based |
| New required field added | adding `spokeAddress` to all entries |
| Array element shape changed | incentive object restructured |

### NOT triggers (no bump needed)

| Change type | Example |
|---|---|
| New optional field added | adding `?hubAddress` (old cache just misses it) |
| Backend-only internal changes | fetcher refactor, DB schema change |
| Field value change within same semantics | price updated from 1.5 to 1.6 |

### How to bump

In `aaveapy/src/lib/cache.ts`, increment `CACHE_VERSION`:

```typescript
// Bump cache version when schema changes.
const CACHE_VERSION = 'X.Y.Z';  // ← increment this
```

The existing mechanism in `getCacheEntry()` automatically discards old-version cache:
```typescript
if (entry.version !== CACHE_VERSION) {
  localStorage.removeItem(key);
  return null;
}
```

### Why this matters (real incident: 2026-05-19)

V4 reserveId format changed from `${marketName}:${chainId}:${token}:${hubName}` to `${chainId}:${spokeAddress}:${tokenAddress}:${hubName}`. Without a version bump, users with cached old-format data would see stale/inconsistent reserveIds until cache naturally expires. The version bump forces a clean fetch on next page load.

### Enforcement

When reviewing a PR that changes backend API response shape, ask: "Does the frontend `CACHE_VERSION` need a bump?"

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
