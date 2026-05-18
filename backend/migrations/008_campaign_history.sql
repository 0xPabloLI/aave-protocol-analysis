-- Campaign history persistence: stores active + expired campaigns for
-- historical APR display. UPSERT deduplicates by (reserve_id, source, side, campaign_key).
-- Apply with: psql "$DATABASE_URL" -f backend/migrations/008_campaign_history.sql

BEGIN;

-- ── campaign_history: one row per (reserve, source, side, campaign_key) ──

CREATE TABLE campaign_history (
  id              BIGSERIAL     PRIMARY KEY,
  reserve_id      TEXT          NOT NULL,
  source          TEXT          NOT NULL,
  side            TEXT          NOT NULL,
  campaign_key    TEXT          NOT NULL,
  campaign_data   JSONB         NOT NULL,
  first_seen_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  expired_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX idx_campaign_history_dedup
  ON campaign_history (reserve_id, source, side, campaign_key);

CREATE INDEX idx_campaign_history_status_window
  ON campaign_history (expired_at, last_seen_at DESC);

CREATE INDEX idx_campaign_history_reserve_source_seen
  ON campaign_history (reserve_id, source, side, last_seen_at DESC);

-- ── campaign_apr_observations: append-only APR time series ──

CREATE TABLE campaign_apr_observations (
  id              BIGSERIAL     PRIMARY KEY,
  observed_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  reserve_id      TEXT          NOT NULL,
  source          TEXT          NOT NULL,
  side            TEXT          NOT NULL,
  campaign_key    TEXT          NOT NULL,
  apr             DOUBLE PRECISION NOT NULL,
  apr_data_hash   TEXT          NOT NULL,
  campaign_data   JSONB         NOT NULL
);

CREATE INDEX idx_campaign_apr_observations_series
  ON campaign_apr_observations (reserve_id, source, side, campaign_key, observed_at);

CREATE INDEX idx_campaign_apr_observations_latest_hash
  ON campaign_apr_observations (reserve_id, source, side, campaign_key, observed_at DESC);

COMMIT;