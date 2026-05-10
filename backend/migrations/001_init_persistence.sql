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
-- * market_snapshots stores high-frequency metrics (price, APY, liquidity).
--   Low-frequency config (rate strategy, caps, addresses) lives in
--   market_configs (created in 002_split_market_configs.sql).

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
    decimals                    INTEGER,
    token_price                 NUMERIC(24, 8),
    supply_apy                  NUMERIC(12, 6),
    borrow_apy                  NUMERIC(12, 6),
    utilization_pct             NUMERIC(8, 4),
    available_liquidity         NUMERIC(40, 0),
    total_variable_debt         NUMERIC(40, 0),
    reserve_size                NUMERIC(40, 0),
    deficit                     NUMERIC(40, 0),
    supply_incentives_apr       NUMERIC(12, 6),
    borrow_incentives_apr       NUMERIC(12, 6),
    incentive_details           JSONB,
    aave_pro_reserve_id         TEXT,
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


CREATE TABLE IF NOT EXISTS oracle_source_configs (
    id              SERIAL PRIMARY KEY,
    source          TEXT        NOT NULL,           -- 'v3' | 'v4'
    pool_key        TEXT        NOT NULL,           -- 'AaveV3Ethereum' or spoke name
    chain_id        INTEGER     NOT NULL,
    pool_address    TEXT,                            -- V3 only, lowercase
    oracle_address  TEXT        NOT NULL,           -- lowercase
    spoke_address   TEXT,                            -- V4 only, lowercase
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source, pool_key, chain_id, pool_address, oracle_address, spoke_address)
);


CREATE TABLE IF NOT EXISTS oracle_prices (
    id              BIGSERIAL PRIMARY KEY,
    snapshot_ts     TIMESTAMPTZ NOT NULL,
    chain_id        INTEGER     NOT NULL,
    token_address   TEXT        NOT NULL,        -- lowercase
    raw_price       NUMERIC(78, 0) NOT NULL,     -- oracle raw uint256
    price_usd       NUMERIC(24, 8) NOT NULL,     -- raw_price / 1e8
    source          TEXT        NOT NULL,        -- 'v3' | 'v4'
    config_id       INTEGER     NOT NULL REFERENCES oracle_source_configs(id),
    CONSTRAINT oracle_prices_unique UNIQUE (snapshot_ts, chain_id, token_address, source, config_id)
);

CREATE INDEX IF NOT EXISTS idx_oracle_prices_ts
    ON oracle_prices (snapshot_ts DESC);
CREATE INDEX IF NOT EXISTS idx_oracle_prices_token_ts
    ON oracle_prices (chain_id, token_address, snapshot_ts DESC);
CREATE INDEX IF NOT EXISTS idx_oracle_prices_config_ts
    ON oracle_prices (config_id, snapshot_ts DESC);

COMMIT;
