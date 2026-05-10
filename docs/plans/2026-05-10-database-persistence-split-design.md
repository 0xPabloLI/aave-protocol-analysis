# Database Persistence Split Design

## Problem

Current `market_snapshots` table writes all ~35 columns every 5 minutes, but many fields rarely change:

- **Interest rate strategy** (slope1/2, optimalUsageRate, baseVariableBorrowRate, reserveFactor) only changes via governance votes
- **Caps** (supplyCap, borrowCap) change infrequently
- **Status flags** (supplyDisabled, borrowDisabled, isFrozen, isPaused) are stable between governance actions
- **Contract addresses** (aToken, vToken, hub/spoke) are immutable after deployment

This creates massive data duplication — ~90%+ of rows have identical config values across consecutive snapshots.

## Design

### Table 1: `market_snapshots` (High-frequency data)

Retained as the primary time-series table for frequently-changing metrics:

| Column | Type | Description |
|--------|------|-------------|
| snapshot_ts | TIMESTAMPTZ | Snapshot timestamp |
| reserve_id | TEXT | Primary key component |
| chain_id, chain_name, market_name | TEXT | Identification |
| token_symbol, token_name, token_address | TEXT | Token info |
| decimals | INTEGER | Token decimals |
| token_price | NUMERIC(24,8) | USD price (changes frequently) |
| supply_apy, borrow_apy | NUMERIC(12,6) | APY rates (changes frequently) |
| utilization_pct | NUMERIC(8,4) | Utilization rate (changes frequently) |
| available_liquidity | NUMERIC(40,0) | Available liquidity |
| total_variable_debt | NUMERIC(40,0) | Total variable debt |
| reserve_size | NUMERIC(40,0) | Total supply |
| deficit | NUMERIC(40,0) | Deficit for accurate APY |
| supply_incentives_apr | NUMERIC(12,6) | Aggregated supply incentives |
| borrow_incentives_apr | NUMERIC(12,6) | Aggregated borrow incentives |
| incentive_details | JSONB | Full incentive breakdown |
| aave_pro_reserve_id | TEXT | Aave Pro reference |

**Unique key**: `(snapshot_ts, reserve_id)`

### Table 2: `market_configs` (Low-frequency configuration)

New table for rarely-changing fields, written only on actual changes:

| Column | Type | Description |
|--------|------|-------------|
| id | BIGSERIAL | Primary key |
| snapshot_ts | TIMESTAMPTZ | First seen timestamp |
| reserve_id | TEXT | Reference to reserve |
| a_token_address | TEXT | aToken contract |
| v_token_address | TEXT | vToken contract |
| supply_cap | NUMERIC(40,0) | Supply cap (raw units) |
| borrow_cap | NUMERIC(40,0) | Borrow cap (raw units) |
| base_variable_borrow_rate | NUMERIC(8,4) | Base borrow rate % |
| reserve_factor | NUMERIC(8,4) | Reserve factor % |
| variable_rate_slope1 | NUMERIC(8,4) | Rate slope 1 % |
| variable_rate_slope2 | NUMERIC(8,4) | Rate slope 2 % |
| optimal_usage_rate | NUMERIC(8,4) | Optimal utilization % |
| supply_disabled | BOOLEAN | Supply status flag |
| borrow_disabled | BOOLEAN | Borrow status flag |
| is_frozen | BOOLEAN | Freeze status flag |
| is_paused | BOOLEAN | Pause status flag |
| hub_id, hub_name, hub_address | TEXT | V4 Hub contract info |
| spoke_id, spoke_name, spoke_address | TEXT | V4 Spoke contract info |

**Unique key**: `(snapshot_ts, reserve_id)` — preserves historical versions.

### Migration Strategy

**Migration file**: `002_split_market_configs.sql`

1. Create `market_configs` table with identical column definitions from `market_snapshots`
2. No data migration needed — historical data stays in `market_snapshots`
3. Add foreign key index on `reserve_id` for JOIN queries

### Persistence Service Changes

**`persistenceService.ts`**:

1. Split `buildMarketRow()` into two functions:
   - `buildSnapshotRow()` — high-frequency fields
   - `buildConfigRow()` — low-frequency fields

2. Add separate content hash tracking for configs:
   - `marketConfigHashes: Map<reserveId, hash>` — only write config row when hash changes

3. Persist flow:
   - `market_snapshots`: write every 5 min (unchanged behavior)
   - `market_configs`: write only when config hash differs from last successful persist

### Impact

**Storage reduction estimate** (for ~200 reserves, 5-min interval):
- **Before**: ~200 rows × 35 cols × 288 writes/day = ~2M column-values/day
- **After**: 
  - Snapshots: ~200 rows × 18 cols × 288 writes/day = ~1M column-values/day  
  - Configs: ~200 rows × 17 cols × ~1-5 writes/day (on actual changes) = ~3-17K column-values/day
- **Estimated savings**: ~50% reduction in total stored data

### Query Considerations

For full reserve data at a specific timestamp:
```sql
SELECT s.*, c.*
FROM market_snapshots s
LEFT JOIN market_configs c 
  ON s.reserve_id = c.reserve_id 
  AND c.snapshot_ts = (
    SELECT MAX(snapshot_ts) FROM market_configs 
    WHERE reserve_id = s.reserve_id AND snapshot_ts <= s.snapshot_ts
  )
WHERE s.snapshot_ts = ?
```

For config-only queries (e.g., "what's the current rate strategy"):
```sql
SELECT * FROM market_configs 
WHERE reserve_id = ?
ORDER BY snapshot_ts DESC LIMIT 1
```
