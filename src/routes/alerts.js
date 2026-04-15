const express = require('express');
const router  = express.Router();
const db      = require('../config/db');

// GET /alerts/:userId
// Query params: limit (default 50), ticker (optional filter)
// Returns recent alerts for a user, newest first.
router.get('/:userId', async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit ?? '50', 10), 200);
  const ticker = req.query.ticker;

  try {
    const params = [req.params.userId, limit];
    let query = `
      SELECT id, ticker, headline, summary, is_urgent, fired_at
      FROM alerts
      WHERE user_id = $1
    `;

    if (ticker) {
      query += ` AND ticker = $3`;
      params.push(ticker.toUpperCase());
    }

    query += ` ORDER BY fired_at DESC LIMIT $2`;

    const result = await db.query(query, params);
    res.json({ alerts: result.rows });
  } catch (err) {
    console.error('[alerts] list error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
