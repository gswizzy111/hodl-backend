-- Run this once against your Railway PostgreSQL database.
-- Safe to re-run: all statements use IF NOT EXISTS / ON CONFLICT.

-- ── Users ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id           SERIAL PRIMARY KEY,
  device_token TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (device_token)
);

-- ── Holdings ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS holdings (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  ticker        TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  asset_type    TEXT NOT NULL DEFAULT 'stock',
  yahoo_symbol  TEXT NOT NULL DEFAULT '',
  alert_enabled BOOLEAN DEFAULT TRUE,
  added_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, ticker)
);

-- ── News articles (shared cache across all users) ──────────────────────────
-- One row per unique headline. tickers[] is updated as more users hold assets
-- mentioned in the same article. Claude's decision is stored permanently.
CREATE TABLE IF NOT EXISTS news_articles (
  id           SERIAL PRIMARY KEY,
  tickers      TEXT[]     NOT NULL,
  headline     TEXT       NOT NULL,
  summary      TEXT       DEFAULT '',
  source       TEXT       DEFAULT '',
  article_url  TEXT       DEFAULT '',
  published_at TIMESTAMPTZ,
  fetched_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (headline)
);

CREATE INDEX IF NOT EXISTS idx_news_tickers   ON news_articles USING GIN(tickers);
CREATE INDEX IF NOT EXISTS idx_news_published ON news_articles(published_at DESC);

-- ── Alerts ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alerts (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  ticker     TEXT    NOT NULL,
  headline   TEXT    NOT NULL,
  summary    TEXT    DEFAULT '',
  is_urgent  BOOLEAN DEFAULT FALSE,
  sent_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id, sent_at DESC);
