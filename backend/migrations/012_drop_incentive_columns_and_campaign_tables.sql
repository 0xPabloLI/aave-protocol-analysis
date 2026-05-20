-- Step 5b: DROP legacy aggregate columns from market_snapshots
-- and DROP physical campaign tables (replaced by views in migration 011).
-- Apply with: psql "$DATABASE_URL" -f backend/migrations/012_drop_incentive_columns_and_campaign_tables.sql

-- Pre-check: ensure migration 011 has been applied
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_views WHERE viewname = 'v_campaign_history') THEN
    RAISE EXCEPTION 'Migration 011 (campaign views) must be applied before 012';
  END IF;
END $$;

BEGIN;

ALTER TABLE market_snapshots DROP COLUMN IF EXISTS supply_incentives_apr;
ALTER TABLE market_snapshots DROP COLUMN IF EXISTS borrow_incentives_apr;
DROP TABLE IF EXISTS campaign_history;
DROP TABLE IF EXISTS campaign_apr_observations;

COMMIT;
