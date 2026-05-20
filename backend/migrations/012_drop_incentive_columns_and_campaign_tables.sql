-- Step 5b: DROP legacy aggregate columns from market_snapshots
-- and DROP physical campaign tables (replaced by views in migration 011).
-- Apply with: psql "$DATABASE_URL" -f backend/migrations/012_drop_incentive_columns_and_campaign_tables.sql

BEGIN;

ALTER TABLE market_snapshots DROP COLUMN IF EXISTS supply_incentives_apr;
ALTER TABLE market_snapshots DROP COLUMN IF EXISTS borrow_incentives_apr;
DROP TABLE IF EXISTS campaign_history;
DROP TABLE IF EXISTS campaign_apr_observations;

COMMIT;
