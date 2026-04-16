const express = require('express');
const router  = express.Router();
const { refreshNewsForTickers, getArticlesForTickers } = require('../jobs/newsRefresh');

// ---------------------------------------------------------------------------
// GET /api/news?tickers=BTC,ETH,AAPL
// Fast — returns only what's already approved in the DB. No Claude calls.
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const { tickers: tickerParam } = req.query;
  if (!tickerParam) return res.status(400).json({ error: 'tickers query param required' });

  const tickers = tickerParam
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);

  try {
    const articles = await getArticlesForTickers(tickers);
    res.json({ articles });
  } catch (err) {
    console.error('[news] GET error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/news/refresh
// Body: { tickers: ["BTC", "ETH", "AAPL"] }
// Fetches fresh articles, runs Claude filter, stores results, returns all.
// Called by the iOS app on launch (loading screen waits for this).
// ---------------------------------------------------------------------------
router.post('/refresh', async (req, res) => {
  const { tickers } = req.body;
  if (!Array.isArray(tickers) || tickers.length === 0) {
    return res.status(400).json({ error: 'tickers array required' });
  }

  const cleaned = tickers.map((t) => t.toUpperCase());
  console.log(`[news] POST /refresh — tickers: [${cleaned.join(', ')}]`);

  try {
    const articles = await refreshNewsForTickers(cleaned);
    console.log(`[news] POST /refresh — returning ${articles.length} articles`);
    res.json({ articles });
  } catch (err) {
    console.error('[news] refresh error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/news/breaking?tickers=BTC,ETH,AAPL
// Returns breaking articles from the last 24 hours for the given tickers.
// ---------------------------------------------------------------------------
router.get('/breaking', async (req, res) => {
  const { tickers: tickerParam } = req.query;
  if (!tickerParam) return res.status(400).json({ error: 'tickers query param required' });

  const tickers = tickerParam
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);

  const db = require('../config/db');
  try {
    const result = await db.query(
      `SELECT id, tickers, headline, summary, source, article_url, published_at
       FROM news_articles
       WHERE is_breaking = TRUE
         AND tickers && $1::text[]
         AND published_at > NOW() - INTERVAL '24 hours'
       ORDER BY published_at DESC`,
      [tickers]
    );
    res.json({ articles: result.rows });
  } catch (err) {
    console.error('[news] breaking error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/alerts?userId=123
// Returns alerts sent to this user in the last 7 days.
// ---------------------------------------------------------------------------
router.get('/alerts', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const db = require('../config/db');
  try {
    const result = await db.query(
      `SELECT id, ticker, headline, summary, is_urgent, sent_at
       FROM alerts
       WHERE user_id = $1
         AND sent_at > NOW() - INTERVAL '7 days'
       ORDER BY sent_at DESC`,
      [userId]
    );
    res.json({ alerts: result.rows });
  } catch (err) {
    console.error('[news] alerts error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
