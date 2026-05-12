-- Remove redundant columns from oracle_prices.
-- - `raw_price`: price_usd already stores derived USD value.
-- - `spoke_address`: denormalized, available via config_id → oracle_source_configs.
-- Apply with: psql "$DATABASE_URL" -f backend/migrations/005_drop_oracle_prices_raw_price.sql

BEGIN;

ALTER TABLE oracle_prices DROP COLUMN IF EXISTS raw_price;
ALTER TABLE oracle_prices DROP COLUMN IF EXISTS spoke_address;

COMMIT;