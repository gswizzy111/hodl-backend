const cron      = require('node-cron');
const db        = require('../config/db');
const Anthropic  = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Generate a short paragraph recap for a single ticker using today's articles.
// ---------------------------------------------------------------------------

async function generateRecap(ticker, articles) {
  if (articles.length === 0) {
    return `It was a quiet day for ${ticker} — no major news today.`;
  }

  const articleText = articles
    .map((a, i) => `${i + 1}. ${a.headline}${a.summary ? ': ' + a.summary : ''}`)
    .join('\n');

  const prompt =
    `You are a financial analyst writing a brief daily recap for retail investors. ` +
    `Based on the following news articles about ${ticker} today, write a single short ` +
    `paragraph (2-4 sentences) in plain English explaining what happened. ` +
    `Be specific about key events and what they mean for investors. ` +
    `Do not use bullet points. Do not start with "${ticker}:". Just write the paragraph.\n\n` +
    `Articles:\n${articleText}`;

  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages:   [{ role: 'user', content: prompt }],
    });
    return (response.content[0]?.text ?? '').trim();
  } catch (err) {
    console.error(`[nightlyRecap] Claude error for ${ticker}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core job — generates recaps for all tickers with articles today.
// ---------------------------------------------------------------------------

async function runNightlyRecapJob() {
  console.log('[nightlyRecap] Starting at', new Date().toISOString());

  // Get all unique tickers that have articles from today
  let tickers;
  try {
    const result = await db.query(
      `SELECT DISTINCT unnest(tickers) AS ticker
       FROM news_articles
       WHERE published_at > NOW() - INTERVAL '24 hours'`
    );
    tickers = result.rows.map((r) => r.ticker);
  } catch (err) {
    console.error('[nightlyRecap] DB error fetching tickers:', err.message);
    return;
  }

  if (tickers.length === 0) {
    console.log('[nightlyRecap] No articles today — skipping');
    return;
  }

  console.log(`[nightlyRecap] Generating recaps for ${tickers.length} tickers`);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  for (const ticker of tickers) {
    // Skip if already generated today
    try {
      const existing = await db.query(
        `SELECT id FROM daily_recaps WHERE ticker = $1 AND date = $2`,
        [ticker, today]
      );
      if (existing.rows.length > 0) {
        console.log(`[nightlyRecap] ${ticker} already done — skipping`);
        continue;
      }
    } catch (err) {
      console.error(`[nightlyRecap] DB check error for ${ticker}:`, err.message);
      continue;
    }

    // Fetch today's articles for this ticker
    let articles;
    try {
      const result = await db.query(
        `SELECT headline, summary FROM news_articles
         WHERE $1 = ANY(tickers)
           AND published_at > NOW() - INTERVAL '24 hours'
         ORDER BY published_at DESC
         LIMIT 8`,
        [ticker]
      );
      articles = result.rows;
    } catch (err) {
      console.error(`[nightlyRecap] DB fetch error for ${ticker}:`, err.message);
      continue;
    }

    const summary = await generateRecap(ticker, articles);
    if (!summary) continue;

    try {
      await db.query(
        `INSERT INTO daily_recaps (ticker, date, summary)
         VALUES ($1, $2, $3)
         ON CONFLICT (ticker, date) DO UPDATE SET summary = EXCLUDED.summary`,
        [ticker, today, summary]
      );
      console.log(`[nightlyRecap] ✓ ${ticker}`);
    } catch (err) {
      console.error(`[nightlyRecap] DB insert error for ${ticker}:`, err.message);
    }
  }

  console.log('[nightlyRecap] Done at', new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Schedule: 8:00 PM every day
// ---------------------------------------------------------------------------

function schedule() {
  cron.schedule('0 20 * * *', runNightlyRecapJob, { timezone: 'America/New_York' });
  console.log('[nightlyRecap] Scheduled: daily at 8 PM ET');
}

module.exports = { schedule, runNightlyRecapJob };
