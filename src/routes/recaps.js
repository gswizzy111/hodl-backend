const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const { runNightlyRecapJob } = require('../jobs/nightlyRecap');

// ---------------------------------------------------------------------------
// GET /api/recaps?tickers=BTC,SOL,AAPL&date=2026-04-16
// Always includes US_ECONOMY entry. Returns change_percent for each ticker.
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const { tickers: tickerParam, date } = req.query;
  if (!tickerParam) return res.status(400).json({ error: 'tickers required' });

  const tickers    = tickerParam.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
  const targetDate = date ?? new Date().toISOString().slice(0, 10);

  // Always fetch US_ECONOMY alongside the requested tickers
  const allTickers = [...new Set([...tickers, 'US_ECONOMY'])];

  try {
    const result = await db.query(
      `SELECT ticker, date, summary, change_percent, generated_at
       FROM daily_recaps
       WHERE ticker = ANY($1) AND date = $2
       ORDER BY
         CASE WHEN ticker = 'US_ECONOMY' THEN 0 ELSE 1 END,
         ticker`,
      [allTickers, targetDate]
    );
    res.json({ recaps: result.rows, date: targetDate });
  } catch (err) {
    console.error('[recaps] GET error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/recaps/generate  (browser-friendly trigger)
// POST /api/recaps/generate
// ---------------------------------------------------------------------------
async function handleGenerate(_req, res) {
  res.json({ message: 'Recap generation started' });
  runNightlyRecapJob().catch((err) =>
    console.error('[recaps] Manual generate error:', err.message)
  );
}

router.get('/generate', handleGenerate);
router.post('/generate', handleGenerate);

module.exports = router;
