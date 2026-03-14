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

### Reserve Size Composition (SDK vs rate-inputs)

The Aave SDK returns `reserve.size` which equals the **total supply** of the reserve:

```
reserve.size.raw = availableLiquidity + totalVariableDebt
```

Where `totalVariableDebt` is calculated from scaled debt:

```
totalVariableDebt = totalScaledVariableDebt × variableBorrowIndex ÷ 10²⁷
```

**Verification example (ENS on Ethereum Mainnet):**

| Source | Field | Value (raw, 18 decimals) |
|--------|-------|--------------------------|
| aave-all-markets-data.json | `reserve.size.amount.raw` | `22357926998021311743149` |
| rate-inputs-raw-data.json | `availableLiquidity` | `20104153613733729749180` |
| rate-inputs-raw-data.json | `totalScaledVariableDebt` | `2168648519088846201515` |
| rate-inputs-raw-data.json | `variableBorrowIndex` | `1039220739858227231737964167` |
| rate-inputs-raw-data.json | `deficit` | `5768310051222005613888` |

Calculation:
```
totalVariableDebt = 2168648519088846201515 × 1039220739858227231737964167 ÷ 10²⁷
                  = 2253773384287581993969

reserve.size.raw  = availableLiquidity + totalVariableDebt
                  = 20104153613733729749180 + 2253773384287581993969
                  = 22357926998021311743149  ✓ (matches SDK output)
```

**Key insight:** `deficit` (bad debt) is **not** included in `reserve.size`. It represents recorded bad debt and is tracked separately for rate calculation purposes (affects `supplyUsageRatio` only).

### On-chain vs API Data Availability

| Field | On-chain RPC | Aave API | Notes |
|-------|:------------:|:--------:|-------|
| `availableLiquidity` | ✅ | ✅ | |
| `reserveFactor` | ✅ | ✅ | |
| `variableRateSlope1/2` | ✅ | ✅ | |
| `optimalUsageRate` | ✅ | ✅ | |
| **`baseVariableBorrowRate`** | ✅ | ❌ | **仅 on-chain 可获取**，用于模拟利率计算 |
| **`deficit`** | ✅ | ❌ | **仅 on-chain 可获取**，用于 Supply APY 计算 |

**结论**：
- `deficit` 必须通过 on-chain RPC 获取
- `baseVariableBorrowRate` 仅 on-chain 可获取（如需模拟利率计算）
- 其他字段均可从 Aave API 获取

---

## 1. Architecture

```text
On-chain RPC (primary, deficit-aware)
  UiPoolDataProvider.getReservesHumanized() + pool.getReserveDeficit()
        |
        v  fallback if RPC fails
Aave API (api.v3.aave.com/graphql)
        |
        v  last resort if API fails
The Graph Subgraph (per chain)
        |
        v
Backend (aave-protocol-analysis)
  - /api/rate-inputs endpoint (separate from /api/markets)
  - In-memory cache with 60s TTL, cron refresh
  - /api/markets is not blocked by rate-inputs failures
        |
        v
Frontend (aaveapy)
  - useReserveRateInputs hook
  - interestRateCalculator.ts (Aave V3 formula + APY conversion)
  - Simulator UI
```

---

## 1.1 Backend: Rate Inputs Service

**Implementation:** `backend/src/services/rateInputsService.ts`

### Data Source Priority

| Priority | Source | Deficit Support | Notes |
|----------|--------|-----------------|-------|
| 1 (primary) | On-chain RPC | ✅ Yes | `UiPoolDataProvider` + direct `pool.getReserveDeficit()` call |
| 2 (fallback) | Aave API | ❌ No | `api.v3.aave.com/graphql`, returns `0` for deficit |
| 3 (last resort) | Subgraph | ❌ No | The Graph, returns `0` for deficit |

### On-chain Fallback Resolution

- On-chain config resolved dynamically from `@bgd-labs/aave-address-book` (`AaveV3*` exports with `CHAIN_ID`, `UI_POOL_DATA_PROVIDER`, `POOL_ADDRESSES_PROVIDER`).
- Reference: `docs/backend/HARDCODE-AND-EXTERNAL-IMPORTS.md`

### Fields Fetched (On-chain Primary Source)

```solidity
// From UiPoolDataProvider.getReservesHumanized():
struct ReserveData {
  address underlyingAsset;     // token address
  uint256 decimals;            // token decimals
  uint256 availableLiquidity;  // real ERC20 balance in aToken contract
  uint256 totalScaledVariableDebt;  // scaled debt (needs index multiplication)
  uint256 variableBorrowIndex; // ray index for debt calculation
  uint256 reserveFactor;       // protocol fee (basis points)
  uint256 variableRateSlope1;  // rate curve parameter (ray)
  uint256 variableRateSlope2;  // rate curve parameter (ray)
  uint256 baseVariableBorrowRate;   // base rate (ray)
  uint256 optimalUsageRatio;   // optimal utilization (ray)
}

// Separately fetched via direct contract call:
pool.getReserveDeficit(asset) → uint256 deficit  // bad debt (raw token units)
```

### API Response Fields

The `/api/rate-inputs` endpoint returns these normalized fields:

| Field | Type | Source | Description |
|-------|------|--------|-------------|
| `marketName` | string | derived | Aave market identifier (e.g., `AaveV3Ethereum`) |
| `chainId` | number | derived | Chain ID |
| `tokenAddress` | string | `underlyingAsset` | Underlying token address (lowercase) |
| `decimals` | number | `decimals` | Token decimals |
| `deficit` | string | `pool.getReserveDeficit()` | Bad debt in raw token units |
| `availableLiquidity` | string | `availableLiquidity` | Raw token units |
| `totalScaledVariableDebt` | string | `totalScaledVariableDebt` | Scaled debt (raw) |
| `variableBorrowIndex` | string | `variableBorrowIndex` | Ray index (27 decimals) |
| `reserveFactor` | string | `reserveFactor` | Basis points (4 decimals) |
| `variableRateSlope1` | string | `variableRateSlope1` | Ray (27 decimals) |
| `variableRateSlope2` | string | `variableRateSlope2` | Ray (27 decimals) |
| `baseVariableBorrowRate` | string | `baseVariableBorrowRate` | Ray (27 decimals) |
| `optimalUsageRate` | string | `optimalUsageRatio` | Ray (27 decimals) |

### GraphQL query (subgraph fallback)

```graphql
{
  reserves(first: 1000) {
    underlyingAsset
    decimals
    availableLiquidity
    totalScaledVariableDebt
    variableBorrowIndex
    reserveFactor
    optimalUtilisationRate
    variableRateSlope1
    variableRateSlope2
    baseVariableBorrowRate
  }
}
```

**Note:** Subgraph does not expose `deficit` field; it defaults to `"0"` when using subgraph source.

### Reliability requirements

- Fetch all chains concurrently via `Promise.allSettled`.
- Add retry with exponential backoff per chain (recommended: 2-3 retries).
- If one chain fails, return remaining chains successfully (failure isolation).

### Polling behavior clarification

- Yes: each scheduled poll reruns all configured chains.
- So a chain that failed in poll N will be retried automatically in poll N+1.
- In-cycle retry still matters: it reduces stale window for transient failures within the same poll.

---

## 1.2 Backend API

### Endpoint

`GET /api/rate-inputs` — 返回所有链的 reserve rate input 数据

| 参数 | 说明 |
|------|------|
| `?chainId=` | 筛选指定链 |
| `?asset=` | 筛选指定 token |
| `?marketName=` | 区分同链同 token 多市场（如 `AaveV3Ethereum` vs `AaveV3EthereumLido`） |

### Cache

- 内存缓存，60s TTL（`BACKEND_CACHE_TTL_MS.realtimeFamily`）
- Cron 定时刷新，API 请求不触发刷新
- 与 `/api/markets` 独立，互不阻塞

---

## 1.3 Env Config

| 变量 | 说明 |
|------|------|
| `THE_GRAPH_API_KEY` | Subgraph 访问所需（最后兜底） |
| RPC URLs | 来自 `@internal/aave-shared-config` |

---

## 1.4 Derived Calculations (Frontend)

Some values can be derived from existing `/api/markets` fields without additional API calls:

### Total Borrowed (USD)

```typescript
// Frontend calculation - no API change needed
const totalBorrowedUsd = reserveSizeUsd * (utilizationPct / 100);
```

Where:
- `reserveSizeUsd` = total supply in USD (from `reserves[].reserveSizeUsd`)
- `utilizationPct` = utilization percentage (from `reserves[].utilizationPct`)

### Available Liquidity (USD)

```typescript
const availableLiquidityUsd = reserveSizeUsd - totalBorrowedUsd;
// or equivalently:
const availableLiquidityUsd = reserveSizeUsd * (1 - utilizationPct / 100);
```

### Borrow Cap Headroom

Using `borrowCapUsd` from API (analogous to existing `supplyCapUsd`):

```typescript
// borrowCapUsd is available in reserves[].borrowCapUsd
const borrowHeadroomUsd = borrowCapUsd - totalBorrowedUsd;
const borrowCapUsedPct = (totalBorrowedUsd / borrowCapUsd) * 100;
```

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
export interface ReserveRateInput {
  marketName: string;
  chainId: number;
  tokenAddress: string;
  availableLiquidity: string;
  totalScaledVariableDebt: string;
  variableBorrowIndex: string;
  reserveFactor: string;
  optimalUsageRate: string;
  variableRateSlope1: string;
  variableRateSlope2: string;
  baseVariableBorrowRate: string;
  decimals: number;
}
```

### 2.3 Hook: `src/hooks/useReserveRateInputs.ts`

- `useReserveRateInput()` now reads from one shared snapshot query (`GET /api/rate-inputs`) and selects by:
  - `chainId + tokenAddress + marketName`
- The home page prefetches this snapshot after markets load, so first tooltip open avoids cold fetch latency.
- This fixes cross-market mismatch on duplicated assets (same chain + same token in multiple Aave markets).

---

## 3. Frontend Impact Assessment

### Functional impact

- No impact on existing main table ranking/sorting logic if simulator path is isolated.
- Simulator can degrade gracefully when rate-input data is missing.

### UX impact

- Keep market table instantly available from `/api/markets`.
- Warm rate-input snapshot in background right after markets load.
- Tooltip uses prefetched snapshot first, then follows normal stale-time refetch policy.
- Show skeleton/placeholder for simulator panel while loading.

### Performance impact

- Additional query cost exists, but isolated from core page data.
- Calculation is lightweight (`BigInt` arithmetic on small input set).
- One shared snapshot query avoids duplicate requests from multiple tooltip opens.
- Optional filters remain available for debug/integration (`?chainId=`, `?asset=`, `?marketName=`).

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

1. Keep simulator UI hidden until user opens tooltip/panel.
2. Home page loads `/markets` first, then background-prefetches `/rate-inputs`.
3. Tooltip reads `chainId + tokenAddress + marketName` from the shared snapshot.
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

## 5. Implementation Reference

### Backend

| 文件 | 说明 |
|------|------|
| `backend/src/services/rateInputsService.ts` | Rate-inputs 数据获取与缓存 |
| `backend/src/routes/rateInputs.ts` | API 路由 |
| `backend/src/controllers/rateInputsController.ts` | 请求处理 |

### Frontend (aaveapy)

| 文件 | 说明 |
|------|------|
| `src/lib/interestRateCalculator.ts` | Aave V3 利率模拟计算 |
| `src/hooks/useReserveRateInputs.ts` | Rate-inputs 数据 hook |
| `src/types/aave.ts` | `ReserveRateInput` 类型定义 |
