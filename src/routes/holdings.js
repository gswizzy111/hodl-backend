const express = require('express');
const router  = express.Router();
const db      = require('../config/db');

// GET /holdings/:userId
// Returns all holdings for a user.
router.get('/:userId', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, ticker, name, asset_type, yahoo_symbol, alert_enabled, added_at
       FROM holdings
       WHERE user_id = $1
       ORDER BY added_at ASC`,
      [req.params.userId]
    );
    res.json({ holdings: result.rows });
  } catch (err) {
    console.error('[holdings] list error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /holdings/:userId
// Body: { ticker, name, assetType, yahooSymbol }
// Adds a new holding.
router.post('/:userId', async (req, res) => {
  const { ticker, name, assetType, yahooSymbol } = req.body;
  if (!ticker || !name || !assetType || !yahooSymbol) {
    return res.status(400).json({ error: 'ticker, name, assetType, yahooSymbol are required' });
  }

  try {
    const result = await db.query(
      `INSERT INTO holdings (user_id, ticker, name, asset_type, yahoo_symbol)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, ticker) DO NOTHING
       RETURNING *`,
      [req.params.userId, ticker.toUpperCase(), name, assetType, yahooSymbol]
    );
    if (result.rows.length === 0) {
      return res.status(409).json({ error: 'Holding already exists' });
    }
    res.status(201).json({ holding: result.rows[0] });
  } catch (err) {
    console.error('[holdings] add error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /holdings/:userId/:holdingId
// Body: { alertEnabled: boolean }
// Toggles the alert flag for a holding.
router.patch('/:userId/:holdingId', async (req, res) => {
  const { alertEnabled } = req.body;
  if (typeof alertEnabled !== 'boolean') {
    return res.status(400).json({ error: 'alertEnabled must be a boolean' });
  }

  try {
    const result = await db.query(
      `UPDATE holdings
       SET alert_enabled = $1
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [alertEnabled, req.params.holdingId, req.params.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Holding not found' });
    }
    res.json({ holding: result.rows[0] });
  } catch (err) {
    console.error('[holdings] patch error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /holdings/:userId/sync
// Body: { holdings: [{ ticker, name, assetType, yahooSymbol }] }
// Bulk upserts all holdings for a user — called on app launch.
router.post('/:userId/sync', async (req, res) => {
  const { holdings } = req.body;
  if (!Array.isArray(holdings)) {
    return res.status(400).json({ error: 'holdings array required' });
  }

  try {
    for (const h of holdings) {
      await db.query(
        `INSERT INTO holdings (user_id, ticker, name, asset_type, yahoo_symbol)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, ticker) DO UPDATE
           SET name = EXCLUDED.name,
               asset_type = EXCLUDED.asset_type,
               yahoo_symbol = EXCLUDED.yahoo_symbol`,
        [req.params.userId, h.ticker.toUpperCase(), h.name, h.assetType || 'stock', h.yahooSymbol || '']
      );
    }
    // Remove any holdings no longer on device
    const currentTickers = holdings.map((h) => h.ticker.toUpperCase());
    if (currentTickers.length > 0) {
      await db.query(
        `DELETE FROM holdings WHERE user_id = $1 AND ticker != ALL($2::text[])`,
        [req.params.userId, currentTickers]
      );
    }
    res.json({ synced: currentTickers.length });
  } catch (err) {
    console.error('[holdings] sync error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /holdings/:userId/:holdingId
router.delete('/:userId/:holdingId', async (req, res) => {
  try {
    await db.query(
      'DELETE FROM holdings WHERE id = $1 AND user_id = $2',
      [req.params.holdingId, req.params.userId]
    );
    res.status(204).send();
  } catch (err) {
    console.error('[holdings] delete error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
