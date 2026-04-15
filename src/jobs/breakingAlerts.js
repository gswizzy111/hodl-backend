const cron = require('node-cron');
const db   = require('../config/db');
const { fetchPolygonNews }   = require('../services/polygon');
const { fetchCryptoRSSNews } = require('../services/rssNews');
const { fetchSECFilings }    = require('../services/secEdgar');
const { triageAlerts }         = require('../services/claude');
const { sendPush }             = require('../services/apns');

// Deduplication: track (userId, headline) pairs sent in the last hour
const recentlySent = new Map();

function isDuplicate(userId, headline) {
  const key = `${userId}:${headline}`;
  const sentAt = recentlySent.get(key);
  if (!sentAt) return false;
  return Date.now() - sentAt < 60 * 60 * 1000;
}

function markSent(userId, headline) {
  recentlySent.set(`${userId}:${headline}`, Date.now());
}

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [key, ts] of recentlySent) {
    if (ts < cutoff) recentlySent.delete(key);
  }
}, 60 * 60 * 1000);

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

  if (users.length === 0) return;

  const allTickers = [...new Set(users.flatMap((u) => u.tickers))];
  console.log(`[breakingAlerts] Polling data for ${allTickers.length} unique tickers`);

  const [polygonEvents, cryptoEvents, secEvents] = await Promise.all([
    fetchPolygonNews(allTickers),
    fetchCryptoRSSNews(allTickers),
    fetchSECFilings(allTickers),
  ]);

  const allEvents = [...polygonEvents, ...cryptoEvents, ...secEvents];
  console.log(`[breakingAlerts] Collected ${allEvents.length} raw events`);

  for (const user of users) {
    const userEvents = allEvents.filter((e) => user.tickers.includes(e.ticker));
    if (userEvents.length === 0) continue;

    const alertsToSend = await triageAlerts(user.tickers, userEvents);

    for (const alert of alertsToSend) {
      if (alert.confidence < 0.7) continue;
      if (isDuplicate(user.id, alert.headline)) continue;

      try {
        await db.query(
          `INSERT INTO alerts (user_id, ticker, headline, summary, is_urgent)
           VALUES ($1, $2, $3, $4, $5)`,
          [user.id, alert.ticker, alert.headline, alert.summary, alert.isUrgent]
        );
      } catch (err) {
        console.error('[breakingAlerts] DB insert error:', err.message);
      }

      try {
        await sendPush(user.device_token, {
          title:    `${alert.ticker} Alert`,
          body:     alert.headline,
          ticker:   alert.ticker,
          isUrgent: alert.isUrgent,
          data:     { summary: alert.summary },
        });
        markSent(user.id, alert.headline);
      } catch (err) {
        console.error('[breakingAlerts] Push error:', err.message);
      }
    }
  }

  console.log('[breakingAlerts] Job finished at', new Date().toISOString());
}

function schedule() {
  cron.schedule('*/15 6-20 * * 1-5', runBreakingAlertsJob, {
    timezone: 'America/New_York',
  });
  console.log('[breakingAlerts] Scheduled: every 15 min, weekdays 6 AM–9 PM ET');
}

module.exports = { schedule, runBreakingAlertsJob };
