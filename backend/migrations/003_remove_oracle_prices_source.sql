-- Remove redundant `source` column from oracle_prices.
-- Apply with: psql "$DATABASE_URL" -f backend/migrations/003_remove_oracle_prices_source.sql
--
-- The `source` ('v3'|'v4') is already available via config_id →
-- oracle_source_configs.source, so keeping it in oracle_prices is normalised
-- redundancy.  Removing it also simplifies the UNIQUE constraint.

BEGIN;

-- 1. Drop the unique constraint/index (001 created a CONSTRAINT;
--    002 replaced it with a UNIQUE INDEX of the same name).
ALTER TABLE oracle_prices DROP CONSTRAINT IF EXISTS oracle_prices_unique;
DROP INDEX IF EXISTS oracle_prices_unique;

-- 2. Drop the redundant column.
ALTER TABLE oracle_prices DROP COLUMN source;

-- 3. Re-create without source (config_id already identifies the source via FK).
ALTER TABLE oracle_prices ADD CONSTRAINT oracle_prices_unique
    UNIQUE (snapshot_ts, chain_id, token_address, config_id);

COMMIT;