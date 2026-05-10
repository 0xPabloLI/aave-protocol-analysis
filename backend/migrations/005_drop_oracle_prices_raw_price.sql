-- Remove redundant `raw_price` column from oracle_prices.
-- `price_usd` already stores the derived USD value; keeping raw_price is
-- unnecessary since it can be reconstructed as price_usd * 1e8 if needed.
-- Apply with: psql "$DATABASE_URL" -f backend/migrations/005_drop_oracle_prices_raw_price.sql

BEGIN;

ALTER TABLE oracle_prices DROP COLUMN raw_price;

COMMIT;