# External API Integration Patterns (Reusable)

Universal patterns for integrating external APIs. Apply to any service consuming third-party data.

## 1. Cache at the Narrowest Useful Layer

### Anti-Pattern: Caching Too Broadly

```typescript
// ❌ Caches entire merged result
const allData = await fetchAndMergeAllSources();
cache.set('all-data', allData, TTL);
```

Problem: One stale source invalidates entire cache.

### Correct Pattern: Per-Source Caching

```typescript
// ✅ Cache each source independently
const marketData = await cachedFetch('markets', fetchMarkets, MARKET_TTL);
const incentives = await cachedFetch('incentives', fetchIncentives, INCENTIVE_TTL);
const metadata = await cachedFetch('metadata', fetchMetadata, METADATA_TTL);

const merged = mergeData(marketData, incentives, metadata);
```

**Why**: Each source refreshes at its natural cadence.

## 2. Fetch Utility: Generic vs Business Logic

### Generic Fetch Utility

```typescript
interface CachedFetchOptions {
  ttlMs: number;
  cacheKey: string;
  bypassCache?: boolean;
}

async function cachedFetch<T>(
  url: string,
  options: CachedFetchOptions
): Promise<{ data: T; fromCache: boolean }> {
  const { ttlMs, cacheKey, bypassCache = false } = options;
  
  if (!bypassCache) {
    const cached = cache.get<T>(cacheKey);
    if (cached && !isExpired(cached, ttlMs)) {
      return { data: cached.data, fromCache: true };
    }
  }
  
  const response = await fetch(url);
  const data = await response.json();
  
  cache.set(cacheKey, { data, fetchedAt: Date.now() });
  return { data, fromCache: false };
}
```

### Business-Specific Indexing (Separate)

```typescript
// Generic fetch
const { data: rawOpportunities } = await cachedFetch<RawOpportunity[]>(
  MERKL_API_URL,
  { ttlMs: MERKL_TTL, cacheKey: 'merkl-opportunities' }
);

// Business indexing (outside fetch utility)
const opportunitiesByChainToken = new Map<string, RawOpportunity>();
for (const opp of rawOpportunities) {
  const key = `${opp.chainId}-${opp.tokenAddress.toLowerCase()}`;
  opportunitiesByChainToken.set(key, opp);
}
```

**Why**: Keeps fetch utility reusable; business logic stays in domain layer.

## 3. Debug Metadata in Raw Snapshots

```typescript
interface RawSnapshot<T> {
  _debug: {
    requestedAt: string;
    endpoint: string;
    queryParams: Record<string, string>;
    pagesScanned: number;
    totalItems: number;
    cacheHit: boolean;
    hitCacheOnly: boolean;
    responseTimeMs: number;
    // API-specific fields
    nextPageToken?: string;
    rateLimitRemaining?: number;
  };
  data: T;
}
```

### Critical: Track Cache Bypass

```typescript
// When debugging, always verify:
if (snapshot._debug.hitCacheOnly && snapshot._debug.pagesScanned === 0) {
  console.warn('No upstream scan happened - data may be stale');
}
```

## 4. Don't Trust Sort Flags

### Problem

API docs say `order=desc` but don't specify the sort field. You assume it's "newest by timestamp" but it's actually "newest by ID" or "highest by score".

### Solution

```typescript
interface Opportunity {
  id: string;
  createdAt: string;  // Actual timestamp
}

async function fetchLatestOpportunities(): Promise<Opportunity[]> {
  const data = await fetchWithSort({ order: 'desc' });
  
  // Don't trust upstream sort - verify timestamps
  const sorted = data.sort((a, b) => 
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  
  // Log if upstream order differs from timestamp order
  if (JSON.stringify(data.map(d => d.id)) !== JSON.stringify(sorted.map(d => d.id))) {
    logger.warn('Upstream sort differs from timestamp sort', {
      upstreamFirst: data[0]?.id,
      timestampFirst: sorted[0]?.id,
    });
  }
  
  return sorted;
}
```

**Rule**: Verify sort order empirically and compare in code when correctness depends on recency.

## 5. Scope Empirical Notes Precisely

### Anti-Pattern

```
// Merkl API returns newest first
const data = await fetchMerkl({ order: 'desc' });
```

### Correct Pattern

```
// Merkl API with status=PAST, type=JSON_AIRDROP returns by createdAt desc
// (verified 2024-03-14 for chainId=1, creatorSlug=aave)
// NOTE: Not verified for status=LIVE or other types
const data = await fetchMerkl({
  status: 'PAST',
  type: 'JSON_AIRDROP',
  order: 'desc',
});
```

**Rule**: Scope notes to exact endpoint + filter combination tested.

## 6. Partition Scans by Controlled Dimensions

When upstream lacks reliable time-based filtering:

```typescript
const CHAINS_TO_SCAN = [1, 137, 42161, 10];  // Known relevant chains

async function scanAllChains(): Promise<Record<number, ScanResult>> {
  const results: Record<number, ScanResult> = {};
  
  for (const chainId of CHAINS_TO_SCAN) {
    const start = Date.now();
    const data = await scanChain(chainId);
    const elapsed = Date.now() - start;
    
    results[chainId] = {
      data,
      _scanMeta: {
        chainId,
        itemsFound: data.length,
        scanTimeMs: elapsed,
      },
    };
  }
  
  return results;
}
```

**Why**: Partition by dimensions you control; record per-partition cost for troubleshooting.

## 7. Server-Side Filters First

### Optimization Priority

1. **Server-side filters** (cheapest, most effective)
2. **Pagination limits** (reduce data transfer)
3. **Client-side filtering** (last resort)

```typescript
// Good: Use server-side filter
const data = await fetch(`${API_URL}?status=LIVE&chain=1&creator=aave`);

// Less good: Fetch all, filter client-side
const all = await fetch(`${API_URL}?status=LIVE`);
const filtered = all.filter(x => x.chain === 1 && x.creator === 'aave');
```

### Validate Filters Work

```typescript
// Before trusting a new filter, verify it reduces results as expected
const withFilter = await fetch(`${API_URL}?creatorSlug=aave`);
const withoutFilter = await fetch(`${API_URL}`);

if (withFilter.length >= withoutFilter.length * 0.9) {
  logger.warn('Filter may not be working as expected', {
    withFilter: withFilter.length,
    withoutFilter: withoutFilter.length,
  });
}
```

## 8. Bypass Cache When Testing

### Problem

Testing API behavior but getting cached results without realizing.

### Solution

```typescript
interface FetchOptions {
  bypassCache?: boolean;
}

async function testApiSort(): Promise<void> {
  // ALWAYS bypass cache when testing API behavior
  const result = await cachedFetch(url, {
    bypassCache: true,  // Critical!
    cacheKey: 'test',
    ttlMs: 0,
  });
  
  // Now verify sort order...
}
```

Log cache bypass status in debug output:

```typescript
logger.debug('API test result', {
  bypassedCache: options.bypassCache,
  fromCache: result.fromCache,
  itemCount: result.data.length,
});
```

## 9. Rate Limiting & Retry

```typescript
interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

async function fetchWithRetry<T>(
  url: string,
  options: RetryOptions = { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000 }
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      const response = await fetch(url);
      
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const delay = retryAfter 
          ? parseInt(retryAfter) * 1000 
          : Math.min(options.baseDelayMs * Math.pow(2, attempt), options.maxDelayMs);
        
        logger.warn('Rate limited, waiting', { delay, attempt });
        await sleep(delay);
        continue;
      }
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      return await response.json();
    } catch (error) {
      lastError = error as Error;
      
      if (attempt < options.maxRetries) {
        const delay = Math.min(
          options.baseDelayMs * Math.pow(2, attempt),
          options.maxDelayMs
        );
        logger.warn('Fetch failed, retrying', { attempt, delay, error: lastError.message });
        await sleep(delay);
      }
    }
  }
  
  throw lastError;
}
```

## 10. Matching Strategy Documentation

Different APIs use different identifiers. Document your matching strategy:

```typescript
/**
 * Identifier matching strategy per API:
 * 
 * | API    | Identifier Format          | Example                                    |
 * |--------|----------------------------|--------------------------------------------|
 * | Merit  | `chainId-tokenAddress`     | `1-0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
 * | Merkl  | chain name + symbol        | `ethereum` + `USDC` (case-insensitive)     |
 * | Brevis | `chainId-tokenAddress`     | `59144-0x...` (Linea)                      |
 * 
 * Normalization:
 * - All addresses lowercase
 * - Chain names mapped to chainId at boundaries
 * - Symbol matching case-insensitive
 */
```

Create index builders for each API:

```typescript
function buildMeritIndex(data: MeritData[]): Map<string, MeritData> {
  const index = new Map<string, MeritData>();
  for (const item of data) {
    const key = `${item.chainId}-${item.tokenAddress.toLowerCase()}`;
    index.set(key, item);
  }
  return index;
}

function buildMerklIndex(data: MerklData[]): Map<string, MerklData> {
  const index = new Map<string, MerklData>();
  for (const item of data) {
    const key = `${item.chainName.toLowerCase()}-${item.symbol.toLowerCase()}`;
    index.set(key, item);
  }
  return index;
}
```
