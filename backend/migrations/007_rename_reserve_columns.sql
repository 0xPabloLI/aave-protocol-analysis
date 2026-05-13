-- Rename reserve columns to align with unified V3/V4 API field names.
-- Apply with: psql "$DATABASE_URL" -f backend/migrations/007_rename_reserve_columns.sql
--
-- Affected tables:
--   market_snapshots: liquidity sizes
--   market_configs:   rate-model parameters
--
-- All columns are renamed in a single transaction. The positional INSERT
-- mappings in persistenceService.ts must be updated atomically with this
-- migration (COLUMNS constants).

BEGIN;

-- market_snapshots: size fields
ALTER TABLE market_snapshots RENAME COLUMN available_liquidity  TO liquidity;
ALTER TABLE market_snapshots RENAME COLUMN total_variable_debt  TO borrowed;
ALTER TABLE market_snapshots RENAME COLUMN reserve_size         TO supplied;

-- market_configs: rate-model fields
ALTER TABLE market_configs RENAME COLUMN base_variable_borrow_rate  TO base_borrow_rate;
ALTER TABLE market_configs RENAME COLUMN reserve_factor             TO protocol_fee;
ALTER TABLE market_configs RENAME COLUMN variable_rate_slope1       TO slope_below_optimal;
ALTER TABLE market_configs RENAME COLUMN variable_rate_slope2       TO slope_above_optimal;
ALTER TABLE market_configs RENAME COLUMN optimal_usage_rate         TO optimal_utilization;

COMMIT;