const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-opus-4-6';

// ---------------------------------------------------------------------------
// ALERT TRIAGE
// ---------------------------------------------------------------------------
// Static system prompt — marked with cache_control so it's cached after the
// first call and reused across all 15-minute polling intervals.

const TRIAGE_SYSTEM = [
  {
    type: 'text',
    text: `You are a financial analyst assistant for the HODL investment app. Your job is to triage raw news and event data and decide which items are worth sending as push notifications to retail investors.

PUSH ALERT CRITERIA — send if ANY apply:
- Price movement: crypto ≥ 5% in 15 min, stock ≥ 3% in 15 min
- Whale transaction ≥ $10M USD
- Major regulatory news (SEC charges, exchange bans, ETF approvals)
- Earnings surprises (beat/miss by > 10%)
- CEO departure or major executive change
- Exchange listing or delisting
- Protocol hack, exploit, or major security breach
- Acquisition announcement or merger
- Fed/central bank policy announcement affecting markets

DO NOT alert on:
- Minor price fluctuations below thresholds
- Routine analyst upgrades/downgrades
- General market commentary
- Duplicate events already reported in the same session

For each item you decide to alert on, respond with a JSON array. Each element:
{
  "ticker": "AAPL",
  "headline": "Short, punchy headline (max 60 chars)",
  "summary": "1–2 sentence explanation of why this matters to the investor (max 200 chars)",
  "isUrgent": true|false,
  "confidence": 0.0–1.0
}

Respond with ONLY the JSON array. If nothing warrants an alert, respond with [].`,
    cache_control: { type: 'ephemeral' },
  },
];

/**
 * Triages a batch of raw events and returns only those worth alerting on.
 *
 * @param {string[]} userTickers - The user's holdings tickers, e.g. ['BTC','AAPL']
 * @param {Array}    rawEvents   - Array of {ticker, headline, summary, source, sourceUrl}
 * @returns {Promise<Array>}     - Filtered array of {ticker, headline, summary, isUrgent}
 */
async function triageAlerts(userTickers, rawEvents) {
  if (rawEvents.length === 0) return [];

  const userContent = `User holds: ${userTickers.join(', ')}

Raw events to triage:
${JSON.stringify(rawEvents, null, 2)}`;

  try {
    const message = await client.messages.create({
      model:      MODEL,
      max_tokens: 2048,
      thinking:   { type: 'adaptive' },
      system:     TRIAGE_SYSTEM,
      messages:   [{ role: 'user', content: userContent }],
    });

    const text = message.content.find((b) => b.type === 'text')?.text ?? '[]';
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[claude] triageAlerts error:', err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// DIGEST GENERATION
// ---------------------------------------------------------------------------
// Static system prompt for digest writing — also cached.

const DIGEST_SYSTEM = [
  {
    type: 'text',
    text: `You are the HODL daily digest writer. Each evening you write a personalized financial summary for a retail investor based on:
1. All news events collected throughout the day for their specific holdings
2. Any alerts that fired during the day

DIGEST FORMAT (Markdown):
## Your HODL Daily Digest — {DATE}

### Portfolio Highlights
Brief 2–3 sentence overview of the biggest moves and themes for this investor's specific holdings.

### {TICKER}: {Company/Asset Name}
- Key event or price move
- Why it matters
- What to watch tomorrow (1 sentence)

(Repeat for each holding that had meaningful news. Skip holdings with no news.)

### Market Context
1–2 sentences on broader market conditions relevant to the portfolio.

### Tomorrow's Watchlist
Bullet list of 2–3 things to keep an eye on.

TONE: Direct, informative, professional but accessible. No hype. No financial advice. Facts and context only. Maximum 600 words total.

Respond with ONLY the Markdown text, no preamble.`,
    cache_control: { type: 'ephemeral' },
  },
];

/**
 * Generates a personalized nightly digest for one user.
 * Uses streaming to handle the longer output reliably.
 *
 * @param {string[]} userTickers - The user's holdings tickers
 * @param {Array}    todayEvents - All events collected today for this user
 * @param {Array}    todayAlerts - All alerts that fired today for this user
 * @returns {Promise<string>}    - Markdown digest text
 */
async function generateDigest(userTickers, todayEvents, todayAlerts) {
  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  const userContent = `Generate the daily digest for: ${dateStr}

User holds: ${userTickers.join(', ')}

Today's alerts that fired (${todayAlerts.length}):
${JSON.stringify(todayAlerts, null, 2)}

All news collected today (${todayEvents.length} items):
${JSON.stringify(todayEvents, null, 2)}`;

  try {
    let digestText = '';

    const stream = await client.messages.stream({
      model:      MODEL,
      max_tokens: 1500,
      thinking:   { type: 'adaptive' },
      system:     DIGEST_SYSTEM,
      messages:   [{ role: 'user', content: userContent }],
    });

    for await (const chunk of stream) {
      if (
        chunk.type === 'content_block_delta' &&
        chunk.delta.type === 'text_delta'
      ) {
        digestText += chunk.delta.text;
      }
    }

    return digestText.trim();
  } catch (err) {
    console.error('[claude] generateDigest error:', err.message);
    return '';
  }
}

module.exports = { triageAlerts, generateDigest };
