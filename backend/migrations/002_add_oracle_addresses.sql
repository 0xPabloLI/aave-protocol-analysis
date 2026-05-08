-- Add oracle_address and pool_address columns to oracle_prices table.
-- Apply with: psql "$DATABASE_URL" -f backend/migrations/002_add_oracle_addresses.sql
--
-- oracle_address: the AaveOracle contract address used for the price query
-- pool_address:   V3 pool address used to query the reserve list (NULL for V4)

BEGIN;

ALTER TABLE oracle_prices
  ADD COLUMN IF NOT EXISTS oracle_address TEXT,
  ADD COLUMN IF NOT EXISTS pool_address   TEXT;

UPDATE oracle_prices SET oracle_address = '' WHERE oracle_address IS NULL;
ALTER TABLE oracle_prices ALTER COLUMN oracle_address SET NOT NULL;

DROP INDEX IF EXISTS oracle_prices_unique_v3;
CREATE UNIQUE INDEX IF NOT EXISTS oracle_prices_unique_v3
    ON oracle_prices (snapshot_ts, chain_id, token_address, source, pool_address)
    WHERE spoke_address IS NULL;

COMMIT;