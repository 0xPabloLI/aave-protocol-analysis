# Caching & Data Freshness Patterns (Reusable)

Universal patterns for caching, TTL management, and data freshness. Apply to any backend service.

## 1. Core Principles

### Separate Write Frequency from Freshness Window

| Concept | Definition | Example |
|---------|------------|---------|
| **Write frequency** | How often producer updates data | Varies by source (e.g. cron every 1 min vs every 10 min) |
| **Freshness window** | How stale consumer tolerates | UI acceptable with 1 min stale |
| **TTL** | Cache expiration time | Set based on both factors |

**Rule**: TTL ≤ min(write_frequency, freshness_window)

### Validate TTL Against Source Cadence

Before setting a TTL:
1. Check API docs for update frequency
2. Sample observed timestamps over time
3. Document the reasoning

❌ **Don't** guess TTL  
✅ **Do** measure source cadence first

## 2. Layered Cache Architecture

### Four-Layer Fallback Chain

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

| Layer | Use Case | TTL Range |
|-------|----------|-----------|
| In-memory | Hot path, sub-second access | 10s - 5min |
| File snapshot | Restart resilience, shared state | 1min - 1hr |
| Online cache | Cross-instance sharing, CDN | 5min - 1hr |
| Upstream API | Source of truth | N/A |

## 3. File Snapshot Design

### Separate Runtime from Debug Files

```
data/
├── runtime/                    # Hot path, small, purpose-built
│   ├── aave-formatted-data.full.json   # Example: optional fetcher artifact (this repo: API uses memory, not this file)
│   └── forecast-meta-lite.json    # Example: auxiliary file some services read (e.g. Merkl forecast lite)
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

## 4. Staleness Detection & Auto-Refresh

### State Machine Pattern

```typescript
type UpdateStatus = 'idle' | 'updating' | 'error';

let updateStatus: UpdateStatus = 'idle';
let activeUpdatePromise: Promise<void> | null = null;
let lastUpdateTime: number = 0;

async function checkAndUpdateIfStale(maxAgeMs: number): Promise<void> {
  const isStale = Date.now() - lastUpdateTime > maxAgeMs;
  
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

## 5. TTL Strategy by Data Type

### User-Critical Data (Markets, Prices)

```typescript
const STALENESS_THRESHOLD_MS = 60_000;  // 1 minute
const HARD_STALE_CAP_MS = 300_000;      // 5 minutes → 503

if (dataAge > HARD_STALE_CAP_MS) {
  throw new ServiceUnavailableError('Data too stale');
}
```

Optional hard cap: **this** codebase’s markets handler does **not** return 503 by snapshot age (only not-ready on cold start); see `docs/backend/data-freshness-mechanism.md`.

- Short TTL (1-5 min)
- Hard cap with 503 response
- `Cache-Control: no-cache, must-revalidate`
- ETag for efficient revalidation

### Side Data (Categories, Metadata)

```typescript
const SIDE_DATA_TTL_MS = 3600_000;  // 1 hour
```

- Longer TTL (30min - 1hr)
- Can serve stale without error
- `Cache-Control: s-maxage=3600`

### Historical/Static Data

```typescript
const HISTORICAL_TTL_MS = 86400_000;  // 24 hours
```

- Very long TTL (hours - days)
- Immutable once written
- `Cache-Control: max-age=86400, immutable`

## 6. Negative Cache Pattern

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

## 7. HTTP Cache Headers

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

## 8. Debug Metadata for Troubleshooting

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

## 9. Multi-Source Cache TTL

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

**Rule**: Set TTL based on the freshest source that materially affects correctness.
