const express = require('express');
const router  = express.Router();
const db      = require('../config/db');

// POST /users/register
// Body: { deviceToken: string }
// Creates or updates a user record. Idempotent (upsert on device_token).
router.post('/register', async (req, res) => {
  const { deviceToken } = req.body;
  if (!deviceToken || typeof deviceToken !== 'string') {
    return res.status(400).json({ error: 'deviceToken is required' });
  }

  try {
    const result = await db.query(
      `INSERT INTO users (device_token)
       VALUES ($1)
       ON CONFLICT (device_token) DO UPDATE
         SET updated_at = NOW()
       RETURNING id, device_token, created_at`,
      [deviceToken]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    console.error('[users] register error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /users/:userId
// Deletes the user and all associated data (cascade).
router.delete('/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    await db.query('DELETE FROM users WHERE id = $1', [userId]);
    res.status(204).send();
  } catch (err) {
    console.error('[users] delete error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
