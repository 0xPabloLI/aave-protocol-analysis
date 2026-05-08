-- Normalize oracle source configs out of oracle_prices.
-- Apply with: psql "$DATABASE_URL" -f backend/migrations/002_add_oracle_source_configs.sql
--
-- Before: oracle_prices had denormalized oracle_address / pool_address / spoke_address.
-- After:  oracle_prices references oracle_source_configs(id) — one row per
--         unique (source, pool_key, oracle_address, pool_address, spoke_address).
--         Configs are immutable once inserted; first_seen_at / last_seen_at
--         track the active window.  When code changes an address, a new config
--         row is inserted on the next persist cycle.

BEGIN;

-- 1. Create config table ---------------------------------------------------
CREATE TABLE IF NOT EXISTS oracle_source_configs (
    id              SERIAL PRIMARY KEY,
    source          TEXT        NOT NULL,           -- 'v3' | 'v4'
    pool_key        TEXT        NOT NULL,           -- 'AaveV3Ethereum' or spoke name
    chain_id        INTEGER     NOT NULL,
    pool_address    TEXT,                            -- V3 only, lowercase
    oracle_address  TEXT        NOT NULL,           -- lowercase
    spoke_address   TEXT,                            -- V4 only, lowercase
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source, pool_key, chain_id, pool_address, oracle_address, spoke_address)
);

-- 2. Backfill from existing oracle_prices rows ----------------------------
-- Populate oracle_source_configs from distinct existing combinations.
-- V3 rows (spoke_address IS NULL): pool_address is missing in old rows,
-- so we use a placeholder and will fix it when the app re-persists.
INSERT INTO oracle_source_configs (source, pool_key, chain_id, pool_address, oracle_address, spoke_address)
SELECT DISTINCT
    source,
    '',                                              -- pool_key unknown for old rows
    chain_id,
    NULL,                                            -- pool_address unknown for old rows
    COALESCE(oracle_address, ''),
    spoke_address                                    -- NULL for V3, non-NULL for V4
FROM oracle_prices
WHERE oracle_address IS NOT NULL AND oracle_address != ''
   OR spoke_address IS NOT NULL
ON CONFLICT (source, pool_key, chain_id, pool_address, oracle_address, spoke_address) DO NOTHING;

-- 3. Add config_id column to oracle_prices ---------------------------------
ALTER TABLE oracle_prices
    ADD COLUMN IF NOT EXISTS config_id INTEGER;

-- 4. Link existing rows to their config ------------------------------------
UPDATE oracle_prices op
SET config_id = osc.id
FROM oracle_source_configs osc
WHERE op.config_id IS NULL
  AND op.source = osc.source
  AND op.chain_id = osc.chain_id
  AND (op.oracle_address = osc.oracle_address
       OR (op.oracle_address IS NULL AND osc.oracle_address = '')
       OR (op.oracle_address = '' AND osc.oracle_address = ''))
  AND NOT (op.spoke_address IS DISTINCT FROM osc.spoke_address)
  AND NOT (op.pool_address IS DISTINCT FROM osc.pool_address);

-- 5. Make config_id NOT NULL + FK ------------------------------------------
ALTER TABLE oracle_prices
    ALTER COLUMN config_id SET NOT NULL,
    ADD CONSTRAINT oracle_prices_config_fk
        FOREIGN KEY (config_id) REFERENCES oracle_source_configs(id);

-- 6. Replace unique indexes ------------------------------------------------
DROP INDEX IF EXISTS oracle_prices_unique_v3;
DROP INDEX IF EXISTS oracle_prices_unique_v4;

CREATE UNIQUE INDEX IF NOT EXISTS oracle_prices_unique
    ON oracle_prices (snapshot_ts, chain_id, token_address, source, config_id);

-- 7. Drop denormalized columns (optional — safe to keep for a while) ------
-- ALTER TABLE oracle_prices DROP COLUMN oracle_address;
-- ALTER TABLE oracle_prices DROP COLUMN pool_address;

COMMIT;