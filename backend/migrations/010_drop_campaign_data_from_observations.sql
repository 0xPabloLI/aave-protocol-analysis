-- Remove redundant campaign_data JSONB from campaign_apr_observations.
-- The full snapshot is already maintained in campaign_history (UPSERT).
-- Observations table only needs APR change points + hash for time-series.
-- Apply with: psql "$DATABASE_URL" -f backend/migrations/010_drop_campaign_data_from_observations.sql

BEGIN;

ALTER TABLE campaign_apr_observations DROP COLUMN campaign_data;

COMMIT;
