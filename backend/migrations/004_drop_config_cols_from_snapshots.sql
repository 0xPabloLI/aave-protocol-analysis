-- Migration 004: Drop config columns from market_snapshots after split.
-- Apply with:  psql "$DATABASE_URL" -f backend/migrations/004_drop_config_cols_from_snapshots.sql
--
-- Rationale:
--   Config columns were moved to market_configs table in 002. The old
--   market_snapshots table still has these columns but new code no longer
--   writes to them. Dropping them reclaims storage and keeps schema lean.
--
--   Historical config data in old snapshots is lost. If you need to
--   preserve it, back up the table before running this migration.
--
--   Columns retained (21):
--     snapshot_ts, reserve_id, chain_id, chain_name, market_name,
--     token_symbol, token_name, token_address, decimals, token_price,
--     supply_apy, borrow_apy, utilization_pct, available_liquidity,
--     total_variable_debt, reserve_size, deficit, supply_incentives_apr,
--     borrow_incentives_apr, incentive_details, aave_pro_reserve_id

BEGIN;

ALTER TABLE market_snapshots
  DROP COLUMN IF EXISTS a_token_address,
  DROP COLUMN IF EXISTS v_token_address,
  DROP COLUMN IF EXISTS supply_cap,
  DROP COLUMN IF EXISTS borrow_cap,
  DROP COLUMN IF EXISTS base_variable_borrow_rate,
  DROP COLUMN IF EXISTS reserve_factor,
  DROP COLUMN IF EXISTS variable_rate_slope1,
  DROP COLUMN IF EXISTS variable_rate_slope2,
  DROP COLUMN IF EXISTS optimal_usage_rate,
  DROP COLUMN IF EXISTS supply_disabled,
  DROP COLUMN IF EXISTS borrow_disabled,
  DROP COLUMN IF EXISTS is_frozen,
  DROP COLUMN IF EXISTS is_paused,
  DROP COLUMN IF EXISTS hub_id,
  DROP COLUMN IF EXISTS hub_name,
  DROP COLUMN IF EXISTS hub_address,
  DROP COLUMN IF EXISTS spoke_id,
  DROP COLUMN IF EXISTS spoke_name,
  DROP COLUMN IF EXISTS spoke_address;

COMMIT;