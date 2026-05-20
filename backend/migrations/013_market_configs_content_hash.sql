-- Migration 013: Add content_hash column to market_configs for warm-start dedup.
--
-- Problem: marketConfigHashes is an in-memory Map cleared on process restart.
-- First tick after restart writes all 354 rows even when content is unchanged,
-- accumulating duplicate rows across deployments.
--
-- Solution: Store the content hash alongside each row. On startup, SELECT the
-- latest hash per reserve_id to warm the in-memory map, making the first tick
-- a no-op when nothing changed.
--
-- Cleanup: Delete older duplicate rows per reserve_id, keeping only the latest.
BEGIN;

ALTER TABLE market_configs ADD COLUMN IF NOT EXISTS content_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_market_configs_content_hash
    ON market_configs (content_hash) WHERE content_hash IS NOT NULL;

-- Delete duplicate rows: for each reserve_id, keep only the row with the
-- latest snapshot_ts (the one with the most recent config version).
-- This is safe because market_configs stores low-frequency data that rarely
-- changes — duplicates from restarts are truly redundant.
DELETE FROM market_configs a
USING market_configs b
WHERE a.reserve_id = b.reserve_id
  AND a.snapshot_ts < b.snapshot_ts;

COMMIT;
