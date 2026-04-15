-- HODL backend schema
-- Run once: psql $DATABASE_URL -f src/db/schema.sql

CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_token  TEXT NOT NULL UNIQUE,       -- APNs device token
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS holdings (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ticker        TEXT NOT NULL,              -- display ticker, e.g. "BTC", "AAPL"
    name          TEXT NOT NULL,
    asset_type    TEXT NOT NULL,             -- crypto | stock | etf | commodity | mutualFund | other
    yahoo_symbol  TEXT NOT NULL,             -- Yahoo Finance symbol, e.g. "BTC-USD", "GC=F"
    alert_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, ticker)
);

CREATE INDEX IF NOT EXISTS idx_holdings_user_id ON holdings(user_id);
CREATE INDEX IF NOT EXISTS idx_holdings_ticker  ON holdings(ticker);

CREATE TABLE IF NOT EXISTS alerts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ticker        TEXT NOT NULL,
    headline      TEXT NOT NULL,
    summary       TEXT,
    source        TEXT,
    source_url    TEXT,
    is_urgent     BOOLEAN NOT NULL DEFAULT FALSE,
    fired_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_user_id  ON alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_ticker   ON alerts(ticker);
CREATE INDEX IF NOT EXISTS idx_alerts_fired_at ON alerts(fired_at);

CREATE TABLE IF NOT EXISTS digests (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date          DATE NOT NULL,
    body          TEXT NOT NULL,             -- markdown-formatted digest text
    delivered_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_digests_user_id ON digests(user_id);
CREATE INDEX IF NOT EXISTS idx_digests_date    ON digests(date);
