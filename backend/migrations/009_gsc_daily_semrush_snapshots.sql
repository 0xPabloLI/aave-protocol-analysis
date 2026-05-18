BEGIN;

CREATE TABLE IF NOT EXISTS gsc_daily (
  id            BIGSERIAL PRIMARY KEY,
  date          DATE         NOT NULL,
  country       TEXT         NOT NULL,
  page          TEXT         NOT NULL,
  query         TEXT         NOT NULL DEFAULT '',
  clicks        INTEGER      NOT NULL DEFAULT 0,
  impressions   INTEGER      NOT NULL DEFAULT 0,
  ctr           NUMERIC(8,5) NOT NULL DEFAULT 0,
  position      NUMERIC(7,2) NOT NULL DEFAULT 0,
  fetched_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (date, country, page, query)
);
CREATE INDEX IF NOT EXISTS idx_gsc_daily_date           ON gsc_daily (date DESC);
CREATE INDEX IF NOT EXISTS idx_gsc_daily_country        ON gsc_daily (country);
CREATE INDEX IF NOT EXISTS idx_gsc_daily_page           ON gsc_daily (page);
CREATE INDEX IF NOT EXISTS idx_gsc_daily_date_country   ON gsc_daily (date DESC, country);

CREATE TABLE IF NOT EXISTS semrush_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  snapshot_date DATE         NOT NULL,
  country       TEXT         NOT NULL,
  keyword       TEXT         NOT NULL,
  volume        INTEGER      NULL,
  position      NUMERIC(6,2) NULL,
  cpc_usd       NUMERIC(8,2) NULL,
  difficulty    NUMERIC(5,2) NULL,
  notes         TEXT         NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (snapshot_date, country, keyword)
);
CREATE INDEX IF NOT EXISTS idx_semrush_country ON semrush_snapshots (country);
CREATE INDEX IF NOT EXISTS idx_semrush_date    ON semrush_snapshots (snapshot_date DESC);

COMMIT;
