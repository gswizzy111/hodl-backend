const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const { refreshNewsForTickers, getArticlesForTickers } = require('../jobs/newsRefresh');

// ---------------------------------------------------------------------------
// GET /api/news?tickers=BTC,ETH,AAPL
// Returns cached articles for the given tickers + MACRO articles for everyone.
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const { tickers: tickerParam } = req.query;
  if (!tickerParam) return res.status(400).json({ error: 'tickers query param required' });

  const tickers = tickerParam.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);

  try {
    // Per-holding articles + MACRO articles for everyone
    const [holdingArticles, macroArticles] = await Promise.all([
      getArticlesForTickers(tickers),
      getArticlesForTickers(['MACRO']),
    ]);

    // Merge, deduplicate by id, sort newest first
    const seen = new Set();
    const articles = [...holdingArticles, ...macroArticles].filter((a) => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    }).sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

    res.json({ articles });
  } catch (err) {
    console.error('[news] GET error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/news/refresh
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
// Returns breaking articles for the given tickers + breaking MACRO for everyone.
// ---------------------------------------------------------------------------
router.get('/breaking', async (req, res) => {
  const { tickers: tickerParam } = req.query;
  if (!tickerParam) return res.status(400).json({ error: 'tickers query param required' });

  const tickers = tickerParam.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
  const allTickers = [...new Set([...tickers, 'MACRO'])];

  try {
    const result = await db.query(
      `SELECT id, tickers, headline, summary, source, article_url, published_at
       FROM news_articles
       WHERE is_breaking = TRUE
         AND tickers && $1::text[]
         AND published_at > NOW() - INTERVAL '24 hours'
       ORDER BY published_at DESC`,
      [allTickers]
    );
    res.json({ articles: result.rows });
  } catch (err) {
    console.error('[news] breaking error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/alerts?userId=123
// ---------------------------------------------------------------------------
router.get('/alerts', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  try {
    const result = await db.query(
      `SELECT id, ticker, headline, summary, is_urgent, sent_at
       FROM alerts
       WHERE user_id = $1 AND sent_at > NOW() - INTERVAL '7 days'
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
