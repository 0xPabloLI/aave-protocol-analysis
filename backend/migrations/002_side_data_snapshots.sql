-- Side-data snapshots: persist categories/FDV/forecast cache to PostgreSQL
-- so that Railway service restarts can warm from DB instead of hitting external APIs.

CREATE TABLE IF NOT EXISTS side_data_snapshots (
    id              SERIAL       PRIMARY KEY,
    source          TEXT         NOT NULL,  -- 'categories' | 'fdv' | 'forecast'
    data            JSONB        NOT NULL,
    fetched_at      TIMESTAMPTZ  NOT NULL,
    content_hash    TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_side_data_source_created
    ON side_data_snapshots (source, created_at DESC);
