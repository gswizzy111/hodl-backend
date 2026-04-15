const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const { runDigestGenerationJob } = require('../jobs/nightlyDigest');

// GET /digest/:userId
// Query params: date (YYYY-MM-DD, defaults to today)
// Returns the digest for a user on a given date.
router.get('/:userId', async (req, res) => {
  const date = req.query.date ?? new Date().toISOString().slice(0, 10);

  try {
    const result = await db.query(
      `SELECT id, date, body, delivered_at, created_at
       FROM digests
       WHERE user_id = $1 AND date = $2::date`,
      [req.params.userId, date]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No digest found for this date' });
    }

    res.json({ digest: result.rows[0] });
  } catch (err) {
    console.error('[digest] get error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /digest/:userId/history
// Returns the last N digests for a user (for the News tab archive).
router.get('/:userId/history', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit ?? '7', 10), 30);

  try {
    const result = await db.query(
      `SELECT id, date, body, delivered_at
       FROM digests
       WHERE user_id = $1
       ORDER BY date DESC
       LIMIT $2`,
      [req.params.userId, limit]
    );
    res.json({ digests: result.rows });
  } catch (err) {
    console.error('[digest] history error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /digest/:userId/generate (dev/admin use — triggers on-demand generation)
router.post('/:userId/generate', async (req, res) => {
  try {
    // Kick off generation asynchronously; respond immediately
    runDigestGenerationJob().catch((err) => {
      console.error('[digest] on-demand generation error:', err.message);
    });
    res.json({ message: 'Digest generation started' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
