const cron = require('node-cron');
const db   = require('../config/db');
const { generateDigest } = require('../services/claude');
const { sendPush }       = require('../services/apns');

// ---------------------------------------------------------------------------
// Job 1: DIGEST GENERATION — 7:45 PM ET daily
// Pulls all of today's events from DB and generates a personalized digest
// for each user via Claude. Stores result in digests table.
// ---------------------------------------------------------------------------

async function runDigestGenerationJob() {
  console.log('[nightlyDigest] Generation job started at', new Date().toISOString());

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  let users;
  try {
    const result = await db.query(`
      SELECT u.id,
             array_agg(DISTINCT h.ticker) AS tickers
      FROM users u
      JOIN holdings h ON h.user_id = u.id
      GROUP BY u.id
    `);
    users = result.rows;
  } catch (err) {
    console.error('[nightlyDigest] DB error fetching users:', err.message);
    return;
  }

  for (const user of users) {
    // Fetch today's alerts for this user
    let todayAlerts = [];
    let todayEvents = [];

    try {
      const alertsRes = await db.query(
        `SELECT ticker, headline, summary, is_urgent, fired_at
         FROM alerts
         WHERE user_id = $1
           AND fired_at::date = $2::date
         ORDER BY fired_at ASC`,
        [user.id, today]
      );
      todayAlerts = alertsRes.rows;
    } catch (err) {
      console.error(`[nightlyDigest] DB error fetching alerts for user ${user.id}:`, err.message);
    }

    // todayEvents would ideally be fetched from a separate event_log table.
    // For now we use todayAlerts as the event source — the same data that
    // drove the breaking alerts. Extend by adding an event_log table if needed.
    todayEvents = todayAlerts;

    // Generate digest
    const digestBody = await generateDigest(user.tickers, todayEvents, todayAlerts);
    if (!digestBody) {
      console.warn(`[nightlyDigest] Empty digest for user ${user.id}`);
      continue;
    }

    // Upsert into digests table
    try {
      await db.query(
        `INSERT INTO digests (user_id, date, body)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, date) DO UPDATE SET body = EXCLUDED.body`,
        [user.id, today, digestBody]
      );
      console.log(`[nightlyDigest] Digest generated for user ${user.id}`);
    } catch (err) {
      console.error(`[nightlyDigest] DB insert digest error for user ${user.id}:`, err.message);
    }
  }

  console.log('[nightlyDigest] Generation job finished at', new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Job 2: DIGEST DELIVERY — 8:00 PM ET daily
// Reads the pre-generated digests and sends push notifications.
// ---------------------------------------------------------------------------

async function runDigestDeliveryJob() {
  console.log('[nightlyDigest] Delivery job started at', new Date().toISOString());

  const today = new Date().toISOString().slice(0, 10);

  let digests;
  try {
    const result = await db.query(
      `SELECT d.id, d.user_id, d.body, u.device_token
       FROM digests d
       JOIN users u ON u.id = d.user_id
       WHERE d.date = $1::date
         AND d.delivered_at IS NULL`,
      [today]
    );
    digests = result.rows;
  } catch (err) {
    console.error('[nightlyDigest] DB error fetching digests:', err.message);
    return;
  }

  console.log(`[nightlyDigest] Delivering ${digests.length} digests`);

  for (const digest of digests) {
    // Extract a short preview for the push notification body
    const preview = extractPreview(digest.body);

    try {
      await sendPush(digest.device_token, {
        title:    'Your HODL Daily Digest is ready',
        body:     preview,
        isUrgent: false,
        data:     { type: 'digest', date: today },
      });

      // Mark as delivered
      await db.query(
        `UPDATE digests SET delivered_at = NOW() WHERE id = $1`,
        [digest.id]
      );

      console.log(`[nightlyDigest] Delivered digest to user ${digest.user_id}`);
    } catch (err) {
      console.error(`[nightlyDigest] Delivery error for user ${digest.user_id}:`, err.message);
    }

    // Small delay between pushes
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log('[nightlyDigest] Delivery job finished at', new Date().toISOString());
}

/**
 * Extracts a push-notification-friendly preview from the digest markdown.
 * Grabs the first non-heading, non-empty line.
 */
function extractPreview(markdownBody) {
  if (!markdownBody) return 'Tap to read your portfolio summary.';
  const lines = markdownBody.split('\n');
  for (const line of lines) {
    const clean = line.replace(/^#+\s*/, '').trim();
    if (clean && !clean.startsWith('---')) {
      return clean.length > 120 ? clean.slice(0, 117) + '…' : clean;
    }
  }
  return 'Tap to read your portfolio summary.';
}

/**
 * Schedules both digest jobs.
 */
function schedule() {
  // 7:45 PM ET — generation
  cron.schedule('45 19 * * *', runDigestGenerationJob, {
    timezone: 'America/New_York',
  });

  // 8:00 PM ET — delivery
  cron.schedule('0 20 * * *', runDigestDeliveryJob, {
    timezone: 'America/New_York',
  });

  console.log('[nightlyDigest] Scheduled: generation at 7:45 PM, delivery at 8:00 PM ET');
}

module.exports = { schedule, runDigestGenerationJob, runDigestDeliveryJob };
