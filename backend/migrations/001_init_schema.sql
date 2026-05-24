-- Squashed init schema (replaces 001–015).
-- This file represents the final state after all 15 migrations applied sequentially.
-- Intermediate tables (campaign_history, campaign_apr_observations) were created
-- and dropped, so they are omitted. Intermediate columns that were added then
-- removed are omitted. Renames are applied directly.
--
-- Apply with:  psql "$DATABASE_URL" -f backend/migrations/001_init_schema.sql

BEGIN;

-- ── market_snapshots: high-frequency metrics (price, APY, liquidity) ──

CREATE TABLE IF NOT EXISTS market_snapshots (
    id                  BIGSERIAL    PRIMARY KEY,
    snapshot_ts         TIMESTAMPTZ  NOT NULL,
    reserve_id          TEXT         NOT NULL,
    token_price         NUMERIC(24, 8),
    supply_apy          NUMERIC(12, 6),
    borrow_apy          NUMERIC(12, 6),
    utilization_pct     NUMERIC(8, 4),
    liquidity           NUMERIC(40, 0),
    borrowed            NUMERIC(40, 0),
    supplied            NUMERIC(40, 0),
    deficit             NUMERIC(40, 0),
    incentive_details   JSONB,
    CONSTRAINT market_snapshots_unique UNIQUE (snapshot_ts, reserve_id)
);

CREATE INDEX IF NOT EXISTS idx_market_snapshots_ts
    ON market_snapshots (snapshot_ts DESC);
CREATE INDEX IF NOT EXISTS idx_market_snapshots_reserve_ts
    ON market_snapshots (reserve_id, snapshot_ts DESC);

-- ── market_configs: low-frequency config (rate strategy, caps, addresses) ──

CREATE TABLE IF NOT EXISTS market_configs (
    id                          BIGSERIAL    PRIMARY KEY,
    snapshot_ts                 TIMESTAMPTZ  NOT NULL,
    reserve_id                  TEXT         NOT NULL,
    a_token_address             TEXT,
    v_token_address             TEXT,
    supply_cap                  NUMERIC(40, 0),
    borrow_cap                  NUMERIC(40, 0),
    base_borrow_rate            NUMERIC(8, 4),
    protocol_fee                NUMERIC(8, 4),
    slope_below_optimal         NUMERIC(8, 4),
    slope_above_optimal         NUMERIC(8, 4),
    optimal_utilization         NUMERIC(8, 4),
    supply_disabled             BOOLEAN,
    borrow_disabled             BOOLEAN,
    is_frozen                   BOOLEAN,
    is_paused                   BOOLEAN,
    hub_id                      TEXT,
    hub_name                    TEXT,
    hub_address                 TEXT,
    spoke_id                    TEXT,
    spoke_name                  TEXT,
    spoke_address               TEXT,
    chain_id                    INTEGER,
    chain_name                  TEXT,
    market_name                 TEXT,
    token_symbol                TEXT,
    token_name                  TEXT,
    token_address               TEXT,
    decimals                    INTEGER,
    aave_pro_reserve_id         TEXT,
    content_hash                TEXT,
    CONSTRAINT market_configs_unique UNIQUE (snapshot_ts, reserve_id)
);

CREATE INDEX IF NOT EXISTS idx_market_configs_reserve_ts
    ON market_configs (reserve_id, snapshot_ts DESC);
CREATE INDEX IF NOT EXISTS idx_market_configs_ts
    ON market_configs (snapshot_ts DESC);
CREATE INDEX IF NOT EXISTS idx_market_configs_content_hash
    ON market_configs (content_hash) WHERE content_hash IS NOT NULL;

-- ── oracle_source_configs: immutable oracle source metadata ──
-- NULL bug fix applied: pool_address and spoke_address are NOT NULL ('' instead of NULL).

CREATE TABLE IF NOT EXISTS oracle_source_configs (
    id              SERIAL       PRIMARY KEY,
    source          TEXT         NOT NULL,
    pool_key        TEXT         NOT NULL,
    chain_id        INTEGER      NOT NULL,
    pool_address    TEXT         NOT NULL DEFAULT '',
    oracle_address  TEXT         NOT NULL,
    spoke_address   TEXT         NOT NULL DEFAULT '',
    first_seen_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT oracle_source_configs_unique_key
        UNIQUE (source, pool_key, chain_id, pool_address, oracle_address, spoke_address)
);

-- ── oracle_prices: time-series oracle price snapshots ──

CREATE TABLE IF NOT EXISTS oracle_prices (
    id              BIGSERIAL    PRIMARY KEY,
    snapshot_ts     TIMESTAMPTZ  NOT NULL,
    chain_id        INTEGER      NOT NULL,
    token_address   TEXT         NOT NULL,
    price_usd       NUMERIC(24, 8) NOT NULL,
    config_id       INTEGER      NOT NULL REFERENCES oracle_source_configs(id),
    CONSTRAINT oracle_prices_unique UNIQUE (snapshot_ts, chain_id, token_address, config_id)
);

CREATE INDEX IF NOT EXISTS idx_oracle_prices_ts
    ON oracle_prices (snapshot_ts DESC);
CREATE INDEX IF NOT EXISTS idx_oracle_prices_token_ts
    ON oracle_prices (chain_id, token_address, snapshot_ts DESC);
CREATE INDEX IF NOT EXISTS idx_oracle_prices_config_ts
    ON oracle_prices (config_id, snapshot_ts DESC);

-- ── gsc_daily: Google Search Console daily data ──

CREATE TABLE IF NOT EXISTS gsc_daily (
    id            BIGSERIAL    PRIMARY KEY,
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

-- ── semrush_snapshots: SemRush keyword tracking snapshots ──

CREATE TABLE IF NOT EXISTS semrush_snapshots (
    id            BIGSERIAL    PRIMARY KEY,
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

-- ── archive_jobs: archive-clean pipeline tracking ──

CREATE TABLE IF NOT EXISTS archive_jobs (
    id              SERIAL       PRIMARY KEY,
    triggered_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    workflow_run_id BIGINT,
    status          TEXT         NOT NULL DEFAULT 'pending',
    pg_size_bytes   BIGINT       NOT NULL,
    cleaned_at      TIMESTAMPTZ,
    error_message   TEXT
);

COMMIT;
