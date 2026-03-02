# Native APR Calculation

## 0. Core Relationship: `availableLiquidity` vs `virtualUnderlyingBalance` vs `deficit`

From `DefaultReserveInterestRateStrategyV2.sol`, `UiPoolDataProviderV3.sol`, and `terminology-and-formulas.md`:

| Field | Source | Meaning |
|---|---|---|
| `virtualUnderlyingBalance` | `pool.getVirtualUnderlyingBalance(asset)` | Protocol bookkeeping balance (`+` supply/repay, `-` withdraw/borrow) |
| `availableLiquidity` | `IERC20(underlying).balanceOf(aTokenAddress)` | Real ERC20 token balance held by the aToken contract |
| `deficit` | `pool.getReserveDeficit(asset)` | Bad debt (liquidation shortfall), passed as `unbacked` in rate params |

### Strategy Formula Context

```solidity
// "available" for utilization calc:
vars.availableLiquidity = virtualUnderlyingBalance + liquidityAdded - liquidityTaken;

// borrowUsageRatio (determines borrow rate):
borrowUsageRatio = totalDebt / (availableLiquidity + totalDebt);

// supplyUsageRatio (determines supply rate, accounts for deficit):
supplyUsageRatio = totalDebt / (availableLiquidity + totalDebt + deficit);
```

### Practical Notes

- Under normal conditions (no flash-loan in flight, no unbacked minting), `availableLiquidity ~= virtualUnderlyingBalance`.
- Flash loans temporarily reduce `availableLiquidity` but do not reduce `virtualUnderlyingBalance`.
- `deficit` affects `supplyUsageRatio`, not `borrowUsageRatio`.

### Can we "just fetch one more field" (`deficit`) from The Graph?

Not always.

- In Aave protocol subgraph schema (`protocol-subgraphs/schemas/v3.schema.graphql`), reserve entity does **not** expose a direct `deficit` field.
- So in many deployments, `deficit` cannot be added to the existing reserve query by simply selecting one extra field.
- If a specific deployment exposes an equivalent field, adding it is low cost.
- If not exposed, fallback is on-chain/RPC reads (`pool.getReserveDeficit(asset)`), which increases RPC calls and complexity.

**Conclusion:** keep Phase 1 without `deficit`, then add optional Phase 2 `deficit` source for high-accuracy mode.

---

## 1. Architecture

```text
The Graph Subgraph (per chain)
        |  independent pipeline, parallel fetch
        v
Backend (aave-protocol-analysis)
  - NEW: /api/rate-inputs endpoint (separate from /api/markets)
  - Rate inputs stored in a separate file and refresh cycle
  - /api/markets is not blocked by subgraph failures
        |
        v
Frontend (aaveapy / feature-merkl-forecast)
  - Fetches reserve rate inputs via separate hook
  - interestRateCalculator.ts (Aave V3 formula + APY conversion)
  - Simulator UI (expandable row or dedicated card)
```

---

## 1.1 Backend: Subgraph Reserve Rate Inputs Service

**New file:** `src/subgraph-service.ts`

### Endpoint format

```text
Primary (recommended):
https://gateway.thegraph.com/api/{apiKey}/subgraphs/id/{deploymentId}

Legacy (only when deployment still has a name endpoint):
https://gateway.thegraph.com/api/{apiKey}/subgraphs/name/aave/{slug}
```

- `deploymentId` / `slug` is **not** `chainId`.
- For current Aave production deployments, `id/{deploymentId}` is the stable format.
- Use explicit mapping: `chainId -> queryPath` (for example `id/<deploymentId>`).

### Where to find valid deployment IDs / slugs

- Aave `protocol-subgraphs` repo Active Deployments list.
- The Graph Explorer pages for each Aave subgraph (can inspect deployment id directly there).
- The Graph Explorer publisher pages (Subgraphs tab) can be used as an index entry, but there is no single guaranteed "Aave all chains" API endpoint.
- Keep mapping in code/config and update when Aave migrates deployments.
- Local sync script: `npm run subgraphs:sync` (writes `docs/api/aave-subgraph-deployments.snapshot.json`).

### Sync source behavior

- `npm run subgraphs:sync` first tries remote GitHub README:
  `https://raw.githubusercontent.com/aave/protocol-subgraphs/master/README.md`.
- If remote is unreachable, it falls back to local mirror path:
  `/Users/pabloli/Documents/protocol-subgraphs/README.md`.
- Snapshot `source` field shows which one was used.

### Fallback chains (runtime-resolved)

- Fallback is no longer a fixed hardcoded chain list.
- Backend resolves fallback capability dynamically from `@bgd-labs/aave-address-book` (`AaveV3*` exports with `CHAIN_ID`, `UI_POOL_DATA_PROVIDER`, `POOL_ADDRESSES_PROVIDER`).
- If subgraph fails or returns partial token coverage, backend uses on-chain reads to补齐 missing reserves when fallback config is resolvable for that chain.

Implementation location: `backend/src/services/rateInputsService.ts` (`resolveOnchainFallbackConfig`).
Hardcode/reference policy: `docs/backend/HARDCODE-AND-EXTERNAL-IMPORTS.md`.

### GraphQL query (per chain)

```graphql
{
  reserves(first: 100) {
    underlyingAsset
    symbol
    decimals
    availableLiquidity
    totalScaledVariableDebt
    variableBorrowIndex
    reserveFactor
    optimalUtilisationRate
    variableRateSlope1
    variableRateSlope2
    baseVariableBorrowRate
    liquidityRate
    variableBorrowRate
  }
}
```

### Reliability requirements

- Fetch all chains concurrently via `Promise.allSettled`.
- Add retry with exponential backoff per chain (recommended: 2-3 retries).
- If one chain fails, return remaining chains successfully (failure isolation).

### Polling behavior clarification

- Yes: each scheduled poll reruns all configured chains.
- So a chain that failed in poll N will be retried automatically in poll N+1.
- In-cycle retry still matters: it reduces stale window for transient failures within the same poll.

---

## 1.2 Backend Route + Storage

**New files:**
- `backend/src/routes/rateInputs.ts`
- `backend/src/controllers/rateInputsController.ts`

### API

- `GET /api/rate-inputs` returns normalized reserve rate input data.
- Default behavior: one response includes all available chains.
- Keep `?chainId=` for targeted chain fetch.
- Keep `?chainId=&asset=` for targeted reserve fetch (fine-grained option, optional in first cut).

### Naming (two-word max, aligned with existing variables)

Decision:
- API path: `/api/rate-inputs`
- Data file: `rate-inputs.json`
- Code variable: `rateInputs`

Short alternatives if renaming is needed later:
1. `rate-inputs`
2. `rate-data`
3. `apr-inputs`

### Storage

- File: `data/runtime/rate-inputs.json`
- Name rationale: this dataset is reserve-level rate formula inputs, not "strategy" metadata.

> Note: data originates from The Graph and is normalized before write.

---

## 1.3 Scheduler Integration and API Impact

In backend API, `GET /api/rate-inputs` is served by `rateInputsService`:

- Uses in-memory snapshot cache with unified TTL.
- Subgraph is primary source; on-chain UiPoolDataProvider is fallback for marked chains.
- Never blocks `/api/markets` if subgraph is slow/down.

### API impact summary

- `/api/markets` payload stays lean (no extra rate inputs).
- New endpoint adds simulator-only read path.
- Better resilience: subgraph partial failures do not cascade to markets API.
- Mild extra backend resource usage (network + parse + storage), bounded by refresh interval.

---

## 1.4 Env Config

- Required for gateway-based subgraph chains:
  - `THE_GRAPH_API_KEY`
- Optional RPC overrides for on-chain fallback chains:
  - per-chain: `RATE_INPUTS_RPC_URL_<chainId>`
    - examples: `RATE_INPUTS_RPC_URL_5000`, `RATE_INPUTS_RPC_URL_9745`
  - batch JSON map: `RATE_INPUTS_RPC_URLS`
    - example: `{"5000":"https://rpc.mantle.xyz","9745":["https://rpc.plasma.to"]}`
- TTL:
  - `BACKEND_CACHE_TTL_MS.realtimeFamily`
  - rate-inputs follows the same 60s same-source bucket as other near-realtime APR snapshot data.

---

## 2. Frontend: Interest Rate Calculator

Working directory:
`/Users/pabloli/Documents/aaveapy/.worktrees/feature-merkl-forecast/` (`feature/merkl-forecast`)

### 2.1 APY conversion implementation choice

**Recommendation:** keep a single source of truth for compounding math.

Preferred order:
1. Reuse `@aave/math-utils` compounded-rate logic (`calculateCompoundedRate` / `rayPow`).
2. If temporary local implementation is needed, enforce parity tests against Aave reference vectors.

Do not keep two independent long-term implementations without parity tests.

### New file: `src/lib/interestRateCalculator.ts`

```ts
const RAY = 10n ** 27n;
const PERCENTAGE_FACTOR = 10000n;
const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;
```

Implements:
- Aave V3 rate simulation after supply amount.
- APR conversion.
- APY conversion aligned with Aave ray compounding behavior.

### 2.2 Type updates: `src/types/aave.ts`

```ts
export interface ReserveRateInputs {
  availableLiquidity: string;
  totalScaledVariableDebt: string;
  variableBorrowIndex: string;
  reserveFactor: string;
  optimalUsageRatio: string;
  variableRateSlope1: string;
  variableRateSlope2: string;
  baseVariableBorrowRate: string;
  liquidityRate: string;
  variableBorrowRate: string;
  decimals: number;
}
```

### 2.3 Hook: `src/hooks/useReserveRateInputs.ts`

- `useReserveRateInputs()` fetches `GET /api/rate-inputs`.
- Independent from `useAaveMarkets()` with separate React Query key.
- Returns `Map<string, ReserveRateInputs>` keyed by `chainId-tokenAddress`.

---

## 3. Frontend Impact Assessment

### Functional impact

- No impact on existing main table ranking/sorting logic if simulator path is isolated.
- Simulator can degrade gracefully when rate-input data is missing.

### UX impact

- Keep market table instantly available from `/api/markets`.
- Lazy-load simulator data only when user opens simulator interaction.
- To avoid "first open delay", prefetch can be triggered on row hover/focus or on viewport-near rows.
- Show skeleton/placeholder for simulator panel while loading.

### Performance impact

- Additional query cost exists, but isolated from core page data.
- Calculation is lightweight (`BigInt` arithmetic on small input set).
- Chain-scoped query option (`?chainId=`) should be default for simulator fetches.
- Reserve-scoped query (`?chainId=&asset=`) is optional; only add if chain-level payload proves too large.

### Payload measurement (external fetch)

Sample query (13 fields, `reserves(first:100)`) against live subgraphs:

- Successful chains sampled: 18
- Total reserves returned: 230
- Total payload size: 122,168 bytes (~119.3 KB)
- Average per chain: ~6.8 KB
- Largest observed: ETH Mainnet V3 ≈ 32.9 KB (63 reserves)

Interpretation:

- Chain-level payload is generally small-to-moderate.
- `?chainId=` should be default frontend path.
- Keep all-chain endpoint for admin/debug or warm cache flows.

### Failure impact

- If `/api/rate-inputs` fails, only simulator feature degrades.
- Core markets dashboard remains usable.

---

## 4. Frontend Business Logic Recommendation

Recommended interaction model:

1. Keep simulator off by default.
2. User expands one row (or opens simulator card) => trigger rate-input fetch.
3. Cache result in React Query; reuse across rows in same chain.
4. Recompute output on each input change locally (no extra backend call while typing amount).
5. If data unavailable, show fallback message and keep default APY display intact.

This keeps first paint fast and bounds failure blast radius.

### Staleness and refetch policy

- Lazy-load does not mean "load once forever".
- If user opens simulator long after initial load and cache age exceeds `staleTime`, frontend refetches before rendering final values.
- Policy location:
  - frontend staleTime buckets: `aaveapy/README.md` (`Data Freshness Policy (Frontend)`)
  - backend TTL/timeout/schedule/rate-limit: `docs/backend/data-freshness-mechanism.md`

### Terminology clarification

- "No round-trip" / "不回源": input changes do not call backend again; calculations happen in-browser.
- Whether to re-fetch backend data depends on elapsed time vs `staleTime` (freshness policy), not on input edits.
- "Simulator degrade" / "降级模拟器": simulator panel shows unavailable/loading state while main markets table remains fully usable.

---

## 5. Reuse Opportunities (Avoid Re-implementation)

### Backend reuse

- Reuse existing scheduler/status pattern from `marketsController` + `updateScheduler`.
- Reuse retry/backoff utility style from `coingeckoController.fetchJsonWithRetry`.
- Reuse data file caching pattern from `DataService` (runtime file + cache refresh).

### Should be abstracted now

| Module | Scope | Suggested location |
|---|---|---|
| `subgraphClient` (fetch/retry/timeout) | backend-only | `backend/src/services/subgraphClient.ts` |
| `subgraphRegistry` (`chainId -> queryPath`, prefer `id/<deploymentId>`) | backend-only (source), frontend read-only mirror optional | `backend/src/config/subgraphRegistry.ts` |
| `rateInputCacheService` (single cache, multi-shape reads) | backend-only | `backend/src/services/rateInputCacheService.ts` |
| `rateMathAdapter` (`@aave/math-utils` wrapper) | frontend-only | `src/lib/rateMathAdapter.ts` |

Guideline:
- Do not force frontend and backend to share runtime modules when dependencies differ.
- Share schema/contracts (`types` or JSON shape), not network/service code.

### Frontend reuse

- Reuse `useAaveMarkets` fetch+cache fallback pattern for new hook.
- Reuse existing APR/APY formatting and display helpers in `src/lib/formatters.ts`.
- Reuse existing table row UI conventions in `PoolsTable.tsx` for expandable simulator.

### Math reuse

- Reuse `@aave/math-utils` reference behavior (`rayPow`, `calculateCompoundedRate`) to avoid formula drift.

---

## 6. Performance and Data Separation

| Concern | Solution |
|---|---|
| Rate-input data bloat `/api/markets` | Keep separate endpoint: `/api/rate-inputs` |
| Subgraph latency affects market API | Independent pipeline/timer + `Promise.allSettled` |
| Extra fields per pool | Fetch/use rate inputs only when simulator is used |
| Token prices | Keep existing `tokenPrices` behavior unchanged |
| All-chain vs chain endpoint overhead | Keep both `/api/rate-inputs` and `/api/rate-inputs?chainId=` but serve from one shared cache snapshot (filter at read time, no duplicate upstream fetch) |

---

## 7. Files to Change

| Project | File | Change |
|---|---|---|
| `aave-protocol-analysis` | `src/subgraph-service.ts` | NEW: subgraph query service |
| `aave-protocol-analysis` | `src/index.ts` | Add `fetchReserveRateInputs()` export |
| `aave-protocol-analysis` | `backend/src/routes/rateInputs.ts` | NEW route |
| `aave-protocol-analysis` | `backend/src/controllers/rateInputsController.ts` | NEW controller |
| `aave-protocol-analysis` | `backend/src/services/rateInputsService.ts` | NEW data service |
| `aave-protocol-analysis` | `backend/src/server.ts` | Register new route |
| `aave-protocol-analysis` | `backend/src/services/updateScheduler.ts` | Add reserve-rate-input refresh timer |
| `aave-protocol-analysis` | `.env`, `.env.example` | Add `THEGRAPH_API_KEY` |
| `aaveapy` (worktree) | `src/lib/interestRateCalculator.ts` | NEW simulation + APY conversion |
| `aaveapy` (worktree) | `src/types/aave.ts` | Add `ReserveRateInputs` |
| `aaveapy` (worktree) | `src/hooks/useReserveRateInputs.ts` | NEW fetch hook |
| `aaveapy` (worktree) | `src/components/dashboard/PoolsTable.tsx` | Option A expandable simulator |
| `aaveapy` (worktree) | `src/components/dashboard/SupplySimulator.tsx` | NEW option B card |
| `aaveapy` (worktree) | `src/pages/Index.tsx` | Wire simulator card |
