# Caching & Data Freshness Standard

Reusable standard for API caching, snapshot freshness, TTL management, and stale-data policy.

## 1. Standard Model

### Four States

| State | Meaning | Behavior |
|---|---|---|
| Fresh | age ≤ `softTTL` | Return normally |
| Soft stale | `softTTL` < age ≤ `hardTTL` | Return old value, mark stale |
| Hard stale | age > `hardTTL` | Reject service or return explicit error |
| Missing | no value yet | Return loading / empty / error |

### Required Fields

Every cache or snapshot must define:

| Field | Meaning |
|---|---|
| `writeInterval` | Producer or cron refresh cadence |
| `softTTL` | Age after which data is considered stale |
| `hardTTL` | Maximum age allowed for serving old data |
| `fallbackMode` | What happens when refresh fails |

### Naming Rules

- Use `*_SOFT_TTL_MS` for soft freshness cadence.
- Use `*_HARD_TTL_MS` for the hard service boundary.
- Use `*_WARM_CRON` for refresh scheduling.
- Do not split the same freshness meaning across multiple variable names.

## 2. Core Principles

### Separate Write Interval from Serve Window

| Concept | Definition | Example |
|---------|------------|---------|
| **Write interval** | How often producer or cron updates data | cron every 1 min or every 10 min |
| **Soft TTL** | When data becomes stale | UI acceptable with 1 min stale |
| **Max serve stale** | Oldest age allowed to serve | 5 min hard stop |
| **Fallback mode** | What to do when refresh fails | reuse previous snapshot, empty result, or 503 |

**Rule**: `softTTL ≤ hardTTL`

### Validate Freshness Against Source Cadence

Before setting freshness controls:
1. Check API docs for update frequency
2. Sample observed timestamps over time
3. Document the reasoning

❌ **Don't** guess TTL or hard stale windows  
✅ **Do** measure source cadence first

## 3. Layered Cache Architecture

### Four-Layer Serving Chain

```
Request
   ↓
┌─────────────────────────────┐
│ 1. In-memory runtime cache  │  ← Fastest, volatile
├─────────────────────────────┤
│ 2. Runtime snapshot file    │  ← Persistent, fast read
├─────────────────────────────┤
│ 3. Online cached fetcher    │  ← Redis/CDN layer
├─────────────────────────────┤
│ 4. Upstream API             │  ← Slowest, authoritative
└─────────────────────────────┘
```

### When to Use Each Layer

| Layer | Use Case | Typical Window |
|-------|----------|-----------|
| In-memory | Hot path, sub-second access | 10s - 5min |
| File snapshot | Restart resilience, shared state | 1min - 1hr |
| Online cache | Cross-instance sharing, CDN | 5min - 1hr |
| Upstream API | Source of truth | N/A |

## 4. File Snapshot Design

### Separate Runtime from Debug Files

```
data/
├── runtime/                    # Hot path, small, purpose-built
│   └── runtime-artifact.json     # Compact file used by runtime code paths
└── debug/                      # Large, verbose, troubleshooting only
    ├── raw-api-response.json
    └── full-scan-results.json
```

**Runtime files**: Minimal, fast to parse, on request path  
**Debug files**: Complete data, slow to parse, never on request path

### Atomic File Writes

```typescript
import { writeFileSync, renameSync } from 'fs';
import { join } from 'path';

function atomicWrite(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.tmp.${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, filePath);  // Atomic on POSIX
}
```

**Why**: Prevents partial reads when file is being written.

### Include Metadata Timestamp

```typescript
interface DataSnapshot<T> {
  _metadata: {
    timestamp: string;      // ISO 8601
    source: string;         // API endpoint or "cache"
    ttlMs?: number;         // For staleness calculation
  };
  data: T;
}
```

**Why**: Enables accurate staleness detection independent of file mtime.

## 5. Staleness Detection & Auto-Refresh

### State Machine Pattern

```typescript
type UpdateStatus = 'idle' | 'updating' | 'error';

let updateStatus: UpdateStatus = 'idle';
let activeUpdatePromise: Promise<void> | null = null;
let lastUpdateTime: number = 0;

async function checkAndUpdateIfStale(hardTtlMs: number): Promise<void> {
  const isStale = Date.now() - lastUpdateTime > hardTtlMs;
  
  if (!isStale) return;
  
  // Already updating? Wait for it
  if (activeUpdatePromise) {
    await activeUpdatePromise;
    return;
  }
  
  // Start new update
  if (updateStatus === 'idle') {
    updateStatus = 'updating';
    activeUpdatePromise = performUpdate()
      .then(() => {
        updateStatus = 'idle';
        lastUpdateTime = Date.now();
      })
      .catch(() => {
        updateStatus = 'error';
      })
      .finally(() => {
        activeUpdatePromise = null;
      });
    
    await activeUpdatePromise;
  }
}
```

**Why**: Prevents duplicate concurrent updates, provides predictable state.

### Smart Waiting vs Stale Response

```typescript
async function getData(maxWaitMs: number = 1000): Promise<Data> {
  if (isStale() && activeUpdatePromise) {
    // Wait briefly for fresh data instead of returning stale
    await Promise.race([
      activeUpdatePromise,
      new Promise(resolve => setTimeout(resolve, maxWaitMs))
    ]);
  }
  return cachedData;
}
```

**Why**: Improves UX by waiting slightly for fresh data rather than always returning stale.

## 6. TTL Strategy by Data Type

### User-Critical Data (Markets, Prices)

```typescript
const SOFT_TTL_MS = 60_000;             // 1 minute
const HARD_TTL_MS = 300_000;     // 5 minutes → 503

if (dataAge > HARD_TTL_MS) {
  throw new ServiceUnavailableError('Data too stale');
}
```

Optional hard cap: some services keep serving stale data until `hardTTL`; others reject once hard stale. Always document the chosen policy.

- Short soft TTL (1-5 min)
- Hard service boundary with 503 or explicit empty/error
- `Cache-Control: no-cache, must-revalidate`
- ETag for efficient revalidation

### Side Data (Categories, Metadata)

```typescript
const SIDE_DATA_SOFT_TTL_MS = 3600_000;  // 1 hour
```

- Longer TTL (30min - 1hr)
- Can serve stale without error up to `hardTTL`
- `Cache-Control: s-maxage=3600`

### Historical/Static Data

```typescript
const HISTORICAL_TTL_MS = 86400_000;  // 24 hours
```

- Very long TTL (hours - days)
- Immutable once written
- `Cache-Control: max-age=86400, immutable`

## 7. Negative Cache Pattern

For expensive scans that often find nothing:

```typescript
interface CacheEntry<T> {
  data: T | null;           // null = confirmed miss
  checkedAt: number;
  hitCacheOnly: boolean;    // Was this a cache-only check?
}

function shouldScan(entry: CacheEntry<T> | undefined): boolean {
  if (!entry) return true;                    // Never checked
  if (entry.data !== null) return false;      // Have data
  if (entry.hitCacheOnly) return true;        // Was cache-only, need real scan
  
  const age = Date.now() - entry.checkedAt;
  return age > NEGATIVE_CACHE_TTL_MS;         // Negative cache expired
}
```

**Why**: Avoids repeated expensive scans for data that doesn't exist.

## 8. HTTP Cache Headers

### Decision Tree

```
Is data user-critical for decisions?
├── Yes → no-cache + ETag
│         (always revalidate, 304 when unchanged)
└── No → Is data slow to change?
         ├── Yes → s-maxage + stale-while-revalidate
         │         (edge cache, background refresh)
         └── No → short max-age
                  (brief browser cache)
```

### Examples

```typescript
// Critical: markets, prices, forecasts
res.setHeader('Cache-Control', 'no-cache, must-revalidate');
res.setHeader('ETag', computeETag(data));

// Side data: categories, static metadata
res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');

// Static: historical data, images
res.setHeader('Cache-Control', 'max-age=86400, immutable');
```

## 9. Debug Metadata for Troubleshooting

Include in debug snapshots:

```typescript
interface DebugSnapshot {
  _debug: {
    requestedAt: string;
    endpoint: string;
    params: Record<string, unknown>;
    pagesScanned: number;
    cacheHit: boolean;
    hitCacheOnly: boolean;    // Important: was upstream actually called?
    responseTimeMs: number;
  };
  data: unknown;
}
```

**Critical**: Always log `hitCacheOnly` flag. `pagesScanned=0` with `hitCacheOnly=true` means no real scan happened.

## 10. Multi-Source Cache TTL

When cached result depends on multiple sources with different cadences:

```typescript
const SOURCE_CADENCES = {
  marketData: 60_000,      // 1 min
  incentiveData: 300_000,  // 5 min
  metadata: 3600_000,      // 1 hour
};

// Option 1: TTL based on freshest critical source
const COMBINED_TTL = Math.min(
  SOURCE_CADENCES.marketData,
  SOURCE_CADENCES.incentiveData
);

// Option 2: Split caches by source
const marketCache = new Cache({ ttl: SOURCE_CADENCES.marketData });
const incentiveCache = new Cache({ ttl: SOURCE_CADENCES.incentiveData });
```

**Rule**: Set `softTTL` based on the freshest source that materially affects correctness; keep `hardTTL` aligned with the strictest acceptable serving window.

## 11. API Service Best Practices

Use these as the default standard for future API services:

- Define `softTTL`, `hardTTL`, and `fallbackMode` for every cache or snapshot.
- Prefer one source of truth for freshness metadata; do not split the same meaning across multiple env vars.
- Reuse base time constants, but keep semantic names distinct.
- Use `hardTTL` for the actual service boundary, not as a vague fallback label.
- Keep request handlers read-only; refresh in cron or explicit warmers.
- Emit `generatedAt`, `ageMs`, `staleTimeMs`, and `fallbackReason` when data can age.
- If a service can return old data safely, document the maximum age explicitly.
- If a service cannot safely return old data, fail fast with a clear error.
