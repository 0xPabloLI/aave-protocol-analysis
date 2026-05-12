-- Migration 006: Move immutable reserve identifier fields from market_snapshots
-- to market_configs. These fields never change for a given reserve_id, so
-- storing them in the time-series table was wasteful (~43% row bloat).
--
-- Fields moved: chain_id, chain_name, market_name, token_symbol, token_name,
--               token_address, decimals, aave_pro_reserve_id
--
-- Apply with: psql "$DATABASE_URL" -f backend/migrations/006_move_identifiers_to_configs.sql

BEGIN;

-- 1. Add identifier columns to market_configs
ALTER TABLE market_configs
  ADD COLUMN IF NOT EXISTS chain_id              INTEGER,
  ADD COLUMN IF NOT EXISTS chain_name            TEXT,
  ADD COLUMN IF NOT EXISTS market_name           TEXT,
  ADD COLUMN IF NOT EXISTS token_symbol          TEXT,
  ADD COLUMN IF NOT EXISTS token_name            TEXT,
  ADD COLUMN IF NOT EXISTS token_address         TEXT,
  ADD COLUMN IF NOT EXISTS decimals              INTEGER,
  ADD COLUMN IF NOT EXISTS aave_pro_reserve_id   TEXT;

-- 2. Drop identifier columns from market_snapshots
ALTER TABLE market_snapshots
  DROP COLUMN IF EXISTS chain_id,
  DROP COLUMN IF EXISTS chain_name,
  DROP COLUMN IF EXISTS market_name,
  DROP COLUMN IF EXISTS token_symbol,
  DROP COLUMN IF EXISTS token_name,
  DROP COLUMN IF EXISTS token_address,
  DROP COLUMN IF EXISTS decimals,
  DROP COLUMN IF EXISTS aave_pro_reserve_id;

-- 3. Update snapshots indexes (chain_id and token_symbol removed)
DROP INDEX IF EXISTS idx_market_snapshots_symbol_ts;
DROP INDEX IF EXISTS idx_market_snapshots_chain_ts;

COMMIT;