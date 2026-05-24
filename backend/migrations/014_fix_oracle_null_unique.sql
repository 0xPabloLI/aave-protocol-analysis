-- Fix NULL-in-UNIQUE bug: deduplicate rows FIRST (under NULL semantics),
-- then replace NULL with '' in oracle_source_configs, and rebuild the unique constraint.
-- Apply with: psql "$DATABASE_URL" -f backend/migrations/014_fix_oracle_null_unique.sql

BEGIN;

-- 1. Deduplicate oracle_source_configs (under current NULL semantics) -----------
-- Group by the 6 unique-key columns treating NULLs as equal (COALESCE → '' for grouping).
-- Keep the row with the smallest id per unique key; delete duplicates.

-- First, update oracle_prices.config_id to point to the surviving row.
UPDATE oracle_prices op
SET config_id = keeper.id
FROM (
    SELECT MIN(id) AS id,
           source, pool_key, chain_id,
           COALESCE(pool_address, '')  AS pool_address,
           COALESCE(oracle_address, '') AS oracle_address,
           COALESCE(spoke_address, '')  AS spoke_address
    FROM oracle_source_configs
    GROUP BY source, pool_key, chain_id,
             COALESCE(pool_address, ''),
             COALESCE(oracle_address, ''),
             COALESCE(spoke_address, '')
    HAVING COUNT(*) > 1
) dup
JOIN oracle_source_configs keeper
    ON COALESCE(keeper.pool_address, '')  = dup.pool_address
   AND COALESCE(keeper.spoke_address, '')  = dup.spoke_address
   AND keeper.source        = dup.source
   AND keeper.pool_key      = dup.pool_key
   AND keeper.chain_id      = dup.chain_id
   AND keeper.oracle_address = dup.oracle_address
   AND keeper.id            = dup.id
WHERE op.config_id IN (
    SELECT osc.id FROM oracle_source_configs osc
    WHERE COALESCE(osc.pool_address, '')  = dup.pool_address
      AND COALESCE(osc.spoke_address, '')  = dup.spoke_address
      AND osc.source        = dup.source
      AND osc.pool_key      = dup.pool_key
      AND osc.chain_id      = dup.chain_id
      AND osc.oracle_address = dup.oracle_address
      AND osc.id            != dup.id
);

-- Delete duplicate rows (keep MIN id per unique key, NULL-aware grouping)
DELETE FROM oracle_source_configs
WHERE id NOT IN (
    SELECT MIN(id)
    FROM oracle_source_configs
    GROUP BY source, pool_key, chain_id,
             COALESCE(pool_address, ''),
             COALESCE(oracle_address, ''),
             COALESCE(spoke_address, '')
);

-- 2. Deduplicate oracle_prices ------------------------------------------------
DELETE FROM oracle_prices
WHERE id NOT IN (
    SELECT MIN(id)
    FROM oracle_prices
    GROUP BY snapshot_ts, chain_id, token_address, source, config_id
);

-- 3. Replace NULL → '' in oracle_source_configs --------------------------------
-- Now safe: duplicates are gone, so UPDATE won't violate the existing constraint.
UPDATE oracle_source_configs
SET spoke_address = ''
WHERE spoke_address IS NULL;

UPDATE oracle_source_configs
SET pool_address = ''
WHERE pool_address IS NULL;

-- 4. Rebuild unique constraint (all NOT NULL now) -----------------------------
DROP INDEX IF EXISTS oracle_source_configs_source_pool_key_chain_id_pool_addre_key;
ALTER TABLE oracle_source_configs
    DROP CONSTRAINT IF EXISTS oracle_source_configs_source_pool_key_chain_id_pool_addre_key;

-- Make columns NOT NULL
ALTER TABLE oracle_source_configs
    ALTER COLUMN pool_address SET NOT NULL,
    ALTER COLUMN spoke_address SET NOT NULL;

-- Add new unique constraint (all columns NOT NULL → ON CONFLICT works)
ALTER TABLE oracle_source_configs
    ADD CONSTRAINT oracle_source_configs_unique_key
        UNIQUE (source, pool_key, chain_id, pool_address, oracle_address, spoke_address);

COMMIT;

-- 5. VACUUM to reclaim space (MUST be outside transaction) --------------------
VACUUM FULL ANALYZE oracle_source_configs;
VACUUM FULL ANALYZE oracle_prices;
