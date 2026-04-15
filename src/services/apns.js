const apn = require('@parse/node-apn');
const path = require('path');

let provider = null;

function getProvider() {
  if (provider) return provider;

  provider = new apn.Provider({
    token: {
      key:    path.resolve(process.env.APNS_KEY_PATH ?? './certs/AuthKey.p8'),
      keyId:  process.env.APNS_KEY_ID,
      teamId: process.env.APNS_TEAM_ID,
    },
    production: process.env.APNS_SANDBOX !== 'true',
  });

  return provider;
}

/**
 * Sends a push notification to a single device.
 *
 * @param {string} deviceToken
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {string} [opts.ticker]   - Used for category / thread grouping
 * @param {boolean}[opts.isUrgent] - Sets interruption level
 * @param {object} [opts.data]     - Extra payload passed to the app
 */
async function sendPush(deviceToken, { title, body, ticker, isUrgent = false, data = {} }) {
  const note = new apn.Notification();

  note.alert           = { title, body };
  note.sound           = isUrgent ? 'default' : null;
  note.badge           = 1;
  note.topic           = process.env.APNS_BUNDLE_ID;
  note.threadId        = ticker ?? 'general';
  note.interruptionLevel = isUrgent ? 'time-sensitive' : 'active';
  note.payload         = { ...data, ticker };
  note.expiry          = Math.floor(Date.now() / 1000) + 3600; // 1 hour TTL

  try {
    const result = await getProvider().send(note, deviceToken);
    if (result.failed?.length > 0) {
      console.error('[apns] Push failed:', JSON.stringify(result.failed));
    }
    return result;
  } catch (err) {
    console.error('[apns] Send error:', err.message);
    throw err;
  }
}

/**
 * Sends a batch of push notifications.
 * Sends sequentially to avoid hammering APNs connections.
 *
 * @param {Array<{deviceToken: string, opts: object}>} items
 */
async function sendPushBatch(items) {
  const results = [];
  for (const { deviceToken, opts } of items) {
    results.push(await sendPush(deviceToken, opts));
    // Small delay between pushes
    await new Promise((r) => setTimeout(r, 50));
  }
  return results;
}

/**
 * Call during graceful shutdown.
 */
function shutdown() {
  if (provider) {
    provider.shutdown();
    provider = null;
  }
}

module.exports = { sendPush, sendPushBatch, shutdown };
