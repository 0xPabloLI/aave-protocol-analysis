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

### Reserve Size Composition (SDK fields)

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
| Aave SDK | `reserve.size.amount.raw` | `22357926998021311743149` |
| Aave SDK | `availableLiquidity` | `20104153613733729749180` |
| Aave SDK | `borrowInfo.total.amount.raw` | `2253773384287581993969` |
| On-chain RPC | `deficit` | `5768310051222005613888` |

Calculation:
```
reserve.size.raw  = availableLiquidity + totalVariableDebt
                  = 20104153613733729749180 + 2253773384287581993969
                  = 22357926998021311743149  ✓ (matches SDK output)
```

> Note: Aave SDK returns `borrowInfo.total` which is already the actual debt (not scaled), so no index calculation needed.

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
- `baseVariableBorrowRate` 优先从 on-chain 获取；**缺失时**后端用 fallback 反推：链上按秒复利，APR = SECONDS_PER_YEAR×((1+APY)^(1/SECONDS_PER_YEAR)−1)，再用该 reserve 的 `utilizationPct`、slopes、optimal 反算 base。计算中**不使用** reserve size。Fallback 返回 `null` 表示无法计算（输入缺失或参数不匹配），`0` 表示计算结果确实为零。调用者仅在返回非 `null` 时设置 `baseBorrowRate`。
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
  - /api/markets endpoint (unified)
  - Parallel fetch: Aave SDK + On-chain RPC
  - On-chain data has 5-min cache fallback
        |
        v
Frontend (aaveapy)
  - useMarketsData hook
  - interestRateCalculator.ts (Aave V3 formula + APY conversion)
  - Simulator UI (with fallback for missing on-chain fields)
```

---

## 1.1 Backend: Data Sources

**Implementation:**
- `packages/aave-fetcher/src/index.ts` - Markets data fetcher (Aave SDK)
- `backend/src/services/onchainDataService.ts` - On-chain data fetcher (RPC)

### Data Source Architecture

| Source | Fields | Fallback |
|--------|--------|----------|
| Aave SDK | Most market data (`supplyApy`, `borrowApy`, `availableLiquidity`, `reserveFactor`, etc.) | Required - API fails if unavailable |
| On-chain RPC | `deficit`, `baseVariableBorrowRate` | Optional - fields absent if RPC fails, 5-min cache on failure |

### On-chain Data via UiPoolDataProvider

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

### API Response Fields (in `/api/markets` reserves)

Fields available in each reserve object:

| Field | Type | Source | Description |
|-------|------|--------|-------------|
| `decimals` | number | Aave SDK | Token decimals |
| `availableLiquidity` | string | Aave SDK | Raw token units |
| `reserveFactor` | string | Aave SDK | Basis points (4 decimals) |
| `variableRateSlope1` | string | Aave SDK | Ray (27 decimals) |
| `variableRateSlope2` | string | Aave SDK | Ray (27 decimals) |
| `optimalUsageRate` | string | Aave SDK | Ray (27 decimals) |
| `deficit` | string | On-chain RPC | Bad debt in raw token units (**optional**) |
| `baseVariableBorrowRate` | string | On-chain RPC | Ray (27 decimals) (**optional**) |

**Important:** On-chain fields (`deficit`, `baseVariableBorrowRate`) may be absent if RPC fails. Frontend should implement fallback (e.g., assume `deficit = "0"`, `baseVariableBorrowRate = "0"`).

### Reliability

- Markets refresh (`fetchMarketsData`) merges on-chain fields from `onchainDataService` cache at write time (not a parallel `Promise.allSettled` to the HTTP client path).
- On-chain data uses **30-minute** per-pool cache TTL (`BACKEND_CACHE_TTL_MS.onchainTtlMs`); RPC failure within TTL reuses cached values.
- If on-chain data is missing and cache expired, reserves still get fallbacks (`deficit` default `"0"`, `baseVariableBorrowRate` calculated when possible).
- Markets payload is required for a successful refresh; on-chain fields are best-effort.

---

## 1.2 Backend API

### Endpoint

`GET /api/markets` — 返回所有链的 reserves 数据（含 on-chain 字段）

### Cache

- 内存快照 + `staleTimeMs` 60s（对应 `softTTL = marketsSoftTtlMs`）；cron 每分钟刷新
- On-chain：独立 cron + **30 分钟** per-pool 缓存（`onchainTtlMs`），RPC 失败时在 TTL / hardTTL 窗口内复用

---

## 1.3 Env Config

| 变量 | 说明 |
|------|------|
| RPC URLs | 来自 `@internal/aave-shared-config`（详见 `docs/backend/rpc-endpoints.md`） |

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

Working directory (example): a clone or git worktree of this repo, e.g. `.worktrees/merkl-forecast/` on branch `merkl-forecast`.

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

### 2.2 Fields for Rate Simulation

All fields are now in the `/api/markets` response under each reserve:

```ts
// Fields from Aave SDK (always present)
decimals: number;
availableLiquidity: string;
reserveFactor: string;
variableRateSlope1: string;
variableRateSlope2: string;
optimalUsageRate: string;

// Fields from On-chain RPC (may be absent)
deficit?: string;
baseVariableBorrowRate?: string;
```

### 2.3 Frontend Fallback Handling

On-chain fields may be absent if RPC fails. Frontend must implement fallbacks:

```ts
// Fallback for missing on-chain fields
const deficit = reserve.deficit ?? '0';
const baseRate = reserve.baseVariableBorrowRate ?? '0';
```

---

## 3. Frontend Impact Assessment

### Functional impact

- All rate simulation fields now in `/api/markets` response
- On-chain fields (`deficit`, `baseVariableBorrowRate`) are optional
- Simulator should degrade gracefully when on-chain data is missing

### UX impact

- Single API call (`/api/markets`) provides all data
- No separate prefetch needed
- Show warning/indicator when using fallback values for simulation

### Fallback strategy

| Field | Fallback Value | Impact |
|-------|---------------|--------|
| `deficit` | `"0"` | Supply APY slightly higher (ignores bad debt) |
| `baseVariableBorrowRate` | `"0"` | Works for most reserves (base rate is typically 0) |

### Failure scenarios

- If Aave SDK fails: entire `/api/markets` fails (503)
- If RPC fails: markets data available, on-chain fields absent
- Frontend should handle both cases gracefully

---

## 4. Frontend Business Logic Recommendation

Recommended approach:

1. Load `/api/markets` for all data (single call)
2. Check if on-chain fields exist before using them
3. Apply fallback values when fields are missing
4. Show UI indicator when simulation uses fallback data
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
| `packages/aave-fetcher/src/index.ts` | Markets data fetcher (Aave SDK) |
| `backend/src/services/onchainDataService.ts` | On-chain data fetcher (deficit, baseVariableBorrowRate) |
| `backend/src/services/marketsService.ts` | Unified markets + on-chain data service |

### Frontend (aaveapy)

| 文件 | 说明 |
|------|------|
| `src/lib/interestRateCalculator.ts` | Aave V3 利率模拟计算 |
| `src/hooks/useMarketsData.ts` | Markets 数据 hook (含 on-chain 字段) |
| `src/types/aave.ts` | Reserve 类型定义 |
