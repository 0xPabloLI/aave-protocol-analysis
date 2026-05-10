-- Migration 002: Split low-frequency config fields into market_configs table.
-- Apply with:  psql "$DATABASE_URL" -f backend/migrations/002_split_market_configs.sql
--
-- Rationale:
--   market_snapshots writes all fields every 5 minutes, but interest rate strategy,
--   caps, status flags, and contract addresses change only via governance (rarely).
--   This creates massive data duplication.
--
-- New table market_configs:
--   - Written ONLY when config fields actually change (content-hash detection).
--   - Preserves historical versions via (snapshot_ts, reserve_id) unique key.
--   - Reduces total stored data by ~50%.

BEGIN;

CREATE TABLE IF NOT EXISTS market_configs (
    id                          BIGSERIAL PRIMARY KEY,
    snapshot_ts                 TIMESTAMPTZ NOT NULL,
    reserve_id                  TEXT        NOT NULL,
    -- Contract addresses (immutable after deployment)
    a_token_address             TEXT,
    v_token_address             TEXT,
    -- Cap limits (change via governance)
    supply_cap                  NUMERIC(40, 0),
    borrow_cap                  NUMERIC(40, 0),
    -- Interest rate strategy parameters (change via governance)
    base_variable_borrow_rate   NUMERIC(8, 4),
    reserve_factor              NUMERIC(8, 4),
    variable_rate_slope1        NUMERIC(8, 4),
    variable_rate_slope2        NUMERIC(8, 4),
    optimal_usage_rate          NUMERIC(8, 4),
    -- Status flags (change via governance / emergency actions)
    supply_disabled             BOOLEAN,
    borrow_disabled             BOOLEAN,
    is_frozen                   BOOLEAN,
    is_paused                   BOOLEAN,
    -- V4 Hub & Spoke contract addresses (immutable after deployment)
    hub_id                      TEXT,
    hub_name                    TEXT,
    hub_address                 TEXT,
    spoke_id                    TEXT,
    spoke_name                  TEXT,
    spoke_address               TEXT,
    CONSTRAINT market_configs_unique UNIQUE (snapshot_ts, reserve_id)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_market_configs_reserve_ts
    ON market_configs (reserve_id, snapshot_ts DESC);
CREATE INDEX IF NOT EXISTS idx_market_configs_ts
    ON market_configs (snapshot_ts DESC);

COMMIT;
