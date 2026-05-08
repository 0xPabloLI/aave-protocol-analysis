-- Database persistence schema for Aave market & oracle snapshots.
-- Apply with:  psql "$DATABASE_URL" -f backend/migrations/001_init_persistence.sql
--
-- Notes:
-- * UNIQUE constraint on (snapshot_ts, reserve_id) lets us re-run the same
--   batch with ON CONFLICT DO NOTHING after a process restart without
--   inserting duplicates.
-- * NUMERIC(40,0) is chosen so raw uint256 wei values fit without overflow.
-- * incentive_details is JSONB so future incentive sources (merit/merkl/brevis
--   etc.) can be added without schema migrations.

BEGIN;

CREATE TABLE IF NOT EXISTS market_snapshots (
    id                          BIGSERIAL PRIMARY KEY,
    snapshot_ts                 TIMESTAMPTZ NOT NULL,
    reserve_id                  TEXT        NOT NULL,
    chain_id                    INTEGER     NOT NULL,
    chain_name                  TEXT        NOT NULL,
    market_name                 TEXT        NOT NULL,
    token_symbol                TEXT        NOT NULL,
    token_name                  TEXT        NOT NULL,
    token_address               TEXT        NOT NULL,
    a_token_address             TEXT,
    v_token_address             TEXT,
    decimals                    INTEGER,
    token_price                 NUMERIC(24, 8),
    supply_apy                  NUMERIC(12, 6),
    borrow_apy                  NUMERIC(12, 6),
    utilization_pct             NUMERIC(8, 4),
    available_liquidity         NUMERIC(40, 0),
    total_variable_debt         NUMERIC(40, 0),
    reserve_size                NUMERIC(40, 0),
    supply_cap                  NUMERIC(40, 0),
    borrow_cap                  NUMERIC(40, 0),
    deficit                     NUMERIC(40, 0),
    base_variable_borrow_rate   NUMERIC(12, 6),
    reserve_factor              NUMERIC(8, 4),
    variable_rate_slope1        NUMERIC(8, 4),
    variable_rate_slope2        NUMERIC(8, 4),
    optimal_usage_rate          NUMERIC(8, 4),
    supply_disabled             BOOLEAN,
    borrow_disabled             BOOLEAN,
    is_frozen                   BOOLEAN,
    is_paused                   BOOLEAN,
    supply_incentives_apr       NUMERIC(12, 6),
    borrow_incentives_apr       NUMERIC(12, 6),
    incentive_details           JSONB,
    aave_pro_reserve_id         TEXT,
    hub_id                      TEXT,
    hub_name                    TEXT,
    hub_address                 TEXT,
    spoke_id                    TEXT,
    spoke_name                  TEXT,
    spoke_address               TEXT,
    CONSTRAINT market_snapshots_unique UNIQUE (snapshot_ts, reserve_id)
);

CREATE INDEX IF NOT EXISTS idx_market_snapshots_ts
    ON market_snapshots (snapshot_ts DESC);
CREATE INDEX IF NOT EXISTS idx_market_snapshots_reserve_ts
    ON market_snapshots (reserve_id, snapshot_ts DESC);
CREATE INDEX IF NOT EXISTS idx_market_snapshots_symbol_ts
    ON market_snapshots (token_symbol, snapshot_ts DESC);
CREATE INDEX IF NOT EXISTS idx_market_snapshots_chain_ts
    ON market_snapshots (chain_id, snapshot_ts DESC);


CREATE TABLE IF NOT EXISTS oracle_prices (
    id              BIGSERIAL PRIMARY KEY,
    snapshot_ts     TIMESTAMPTZ NOT NULL,
    chain_id        INTEGER     NOT NULL,
    token_address   TEXT        NOT NULL,        -- lowercase
    raw_price       NUMERIC(78, 0) NOT NULL,     -- oracle raw uint256
    price_usd       NUMERIC(24, 8) NOT NULL,     -- raw_price / 1e8
    source          TEXT        NOT NULL,        -- 'v3' | 'v4'
    spoke_address   TEXT                         -- v4 only (V3 rows = NULL)
);

-- Partial unique indexes: PostgreSQL treats NULL as distinct in UNIQUE,
-- so V3 (spoke_address=NULL) and V4 (spoke_address non-NULL) need separate
-- unique indexes to guarantee idempotency.
CREATE UNIQUE INDEX IF NOT EXISTS oracle_prices_unique_v3
    ON oracle_prices (snapshot_ts, chain_id, token_address, source)
    WHERE spoke_address IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS oracle_prices_unique_v4
    ON oracle_prices (snapshot_ts, chain_id, token_address, source, spoke_address)
    WHERE spoke_address IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_oracle_prices_ts
    ON oracle_prices (snapshot_ts DESC);
CREATE INDEX IF NOT EXISTS idx_oracle_prices_token_ts
    ON oracle_prices (chain_id, token_address, snapshot_ts DESC);

COMMIT;
