const cron = require('node-cron');
const db   = require('../config/db');
const { fetchWhaleAlerts }     = require('../services/whaleAlert');
const { fetchPolygonNews }     = require('../services/polygon');
const { fetchCryptoPanicNews } = require('../services/cryptoPanic');
const { fetchSECFilings }      = require('../services/secEdgar');
const { triageAlerts }         = require('../services/claude');
const { sendPush }             = require('../services/apns');

// Deduplication: track (userId, headline) pairs sent in the last hour
// to avoid repeat notifications for the same event.
const recentlySent = new Map(); // key: `${userId}:${headline}` → timestamp

function isDuplicate(userId, headline) {
  const key = `${userId}:${headline}`;
  const sentAt = recentlySent.get(key);
  if (!sentAt) return false;
  return Date.now() - sentAt < 60 * 60 * 1000; // 1-hour dedup window
}

function markSent(userId, headline) {
  recentlySent.set(`${userId}:${headline}`, Date.now());
}

// Clean up old dedup entries every hour
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [key, ts] of recentlySent) {
    if (ts < cutoff) recentlySent.delete(key);
  }
}, 60 * 60 * 1000);

/**
 * Main polling job — runs every 15 minutes on weekdays 6 AM – 9 PM ET.
 * For each user, fetches all data sources, triages with Claude, sends push alerts.
 */
async function runBreakingAlertsJob() {
  console.log('[breakingAlerts] Job started at', new Date().toISOString());

  let users;
  try {
    const result = await db.query(`
      SELECT u.id, u.device_token,
             array_agg(h.ticker)       AS tickers,
             array_agg(h.yahoo_symbol) AS yahoo_symbols
      FROM users u
      JOIN holdings h ON h.user_id = u.id AND h.alert_enabled = TRUE
      GROUP BY u.id, u.device_token
    `);
    users = result.rows;
  } catch (err) {
    console.error('[breakingAlerts] DB error fetching users:', err.message);
    return;
  }

  if (users.length === 0) {
    console.log('[breakingAlerts] No users with alert-enabled holdings');
    return;
  }

  // Aggregate all unique tickers across users so we fetch data once
  const allTickers = [...new Set(users.flatMap((u) => u.tickers))];
  console.log(`[breakingAlerts] Polling data for ${allTickers.length} unique tickers`);

  // Fetch from all data sources in parallel
  const [whaleEvents, polygonEvents, cryptoEvents, secEvents] = await Promise.all([
    fetchWhaleAlerts(allTickers),
    fetchPolygonNews(allTickers),
    fetchCryptoPanicNews(allTickers),
    fetchSECFilings(allTickers),
  ]);

  const allEvents = [...whaleEvents, ...polygonEvents, ...cryptoEvents, ...secEvents];
  console.log(`[breakingAlerts] Collected ${allEvents.length} raw events`);

  // Process each user
  for (const user of users) {
    const userEvents = allEvents.filter((e) => user.tickers.includes(e.ticker));
    if (userEvents.length === 0) continue;

    // Let Claude decide what's worth alerting on
    const alertsToSend = await triageAlerts(user.tickers, userEvents);

    for (const alert of alertsToSend) {
      if (alert.confidence < 0.7) continue;
      if (isDuplicate(user.id, alert.headline)) continue;

      // Persist alert to DB
      try {
        await db.query(
          `INSERT INTO alerts (user_id, ticker, headline, summary, is_urgent)
           VALUES ($1, $2, $3, $4, $5)`,
          [user.id, alert.ticker, alert.headline, alert.summary, alert.isUrgent]
        );
      } catch (err) {
        console.error('[breakingAlerts] DB insert alert error:', err.message);
      }

      // Send push notification
      try {
        await sendPush(user.device_token, {
          title:    `${alert.ticker} Alert`,
          body:     alert.headline,
          ticker:   alert.ticker,
          isUrgent: alert.isUrgent,
          data:     { summary: alert.summary },
        });
        markSent(user.id, alert.headline);
        console.log(`[breakingAlerts] Sent alert to user ${user.id}: ${alert.headline}`);
      } catch (err) {
        console.error('[breakingAlerts] Push error:', err.message);
      }
    }
  }

  console.log('[breakingAlerts] Job finished at', new Date().toISOString());
}

/**
 * Schedules the breaking alerts cron.
 * Fires every 15 minutes, weekdays only, 6:00 AM – 8:45 PM ET.
 * (node-cron itself fires at :00, :15, :30, :45 each hour in the range.)
 */
function schedule() {
  // */15 6-20 * * 1-5 → every 15 min, hours 6–20, Mon–Fri
  cron.schedule('*/15 6-20 * * 1-5', runBreakingAlertsJob, {
    timezone: 'America/New_York',
  });
  console.log('[breakingAlerts] Scheduled: every 15 min, weekdays 6 AM–9 PM ET');
}

module.exports = { schedule, runBreakingAlertsJob };
