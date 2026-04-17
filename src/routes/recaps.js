const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const { runNightlyRecapJob } = require('../jobs/nightlyRecap');

// ---------------------------------------------------------------------------
// GET /api/recaps?tickers=BTC,SOL,AAPL&date=2026-04-16
// Returns AI-generated daily recap paragraphs for the given tickers and date.
// Date defaults to today if omitted.
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const { tickers: tickerParam, date } = req.query;
  if (!tickerParam) return res.status(400).json({ error: 'tickers required' });

  const tickers = tickerParam.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
  const targetDate = date ?? new Date().toISOString().slice(0, 10);

  try {
    const result = await db.query(
      `SELECT ticker, date, summary, generated_at
       FROM daily_recaps
       WHERE ticker = ANY($1) AND date = $2
       ORDER BY ticker`,
      [tickers, targetDate]
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
// Manually triggers recap generation (useful for testing outside 8 PM).
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
