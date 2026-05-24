-- Archive jobs tracking table for the archive-clean pipeline.
-- Apply with: psql "$DATABASE_URL" -f backend/migrations/015_archive_jobs.sql

BEGIN;

CREATE TABLE IF NOT EXISTS archive_jobs (
    id              SERIAL PRIMARY KEY,
    triggered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    workflow_run_id BIGINT,
    status          TEXT        NOT NULL DEFAULT 'pending',  -- pending | succeeded | failed
    pg_size_bytes   BIGINT     NOT NULL,
    cleaned_at      TIMESTAMPTZ,
    error_message   TEXT
);

COMMIT;
