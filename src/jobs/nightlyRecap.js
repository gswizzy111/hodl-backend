const cron     = require('node-cron');
const db       = require('../config/db');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Fetch today's price change from Yahoo Finance
// Returns { open, close, changePercent } or null if unavailable
// ---------------------------------------------------------------------------

async function fetchPriceChange(yahooSymbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1d&interval=1d`;
    const res  = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal:  AbortSignal.timeout(8000),
    });
    const json   = await res.json();
    const meta   = json?.chart?.result?.[0]?.meta;
    if (!meta) return null;

    const open  = meta.chartPreviousClose ?? meta.previousClose;
    const close = meta.regularMarketPrice ?? meta.postMarketPrice;
    if (!open || !close) return null;

    const changePercent = ((close - open) / open) * 100;
    return { open, close, changePercent };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Generate a recap paragraph for one ticker
// ---------------------------------------------------------------------------

async function generateRecap(ticker, articles, priceData) {
  const articleText = articles.length > 0
    ? articles.map((a, i) => `${i + 1}. ${a.headline}${a.summary ? ': ' + a.summary : ''}`).join('\n')
    : null;

  let priceContext = '';
  if (priceData) {
    const dir     = priceData.changePercent >= 0 ? 'higher' : 'lower';
    const pct     = Math.abs(priceData.changePercent).toFixed(2);
    const close   = priceData.close.toFixed(2);
    priceContext  = `\nPrice data: ${ticker} closed ${dir} today at $${close} (${priceData.changePercent >= 0 ? '+' : ''}${priceData.changePercent.toFixed(2)}%).`;
  }

  if (!articleText && !priceContext) {
    return `It was a quiet day for ${ticker} — no major news or price movement today.`;
  }

  const prompt =
    `You are a financial analyst writing a brief daily recap for retail investors.\n` +
    `${priceContext}\n` +
    `${articleText ? `Today's news articles about ${ticker}:\n${articleText}\n` : ''}` +
    `\nWrite a single short paragraph (2-4 sentences) in plain English that:\n` +
    `1. States clearly whether ${ticker} closed higher or lower today and by roughly how much\n` +
    `2. Explains the main reason(s) why based on the news (or notes it was a quiet day if no news)\n` +
    `Be specific and direct. Do not use bullet points. Do not start with "${ticker}:". Just write the paragraph.`;

  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 220,
      messages:   [{ role: 'user', content: prompt }],
    });
    return (response.content[0]?.text ?? '').trim();
  } catch (err) {
    console.error(`[nightlyRecap] Claude error for ${ticker}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core job
// ---------------------------------------------------------------------------

async function runNightlyRecapJob() {
  console.log('[nightlyRecap] Starting at', new Date().toISOString());

  // Get tickers that have articles today, along with their yahoo_symbol from holdings
  let tickers;
  try {
    const result = await db.query(
      `SELECT DISTINCT unnest(n.tickers) AS ticker
       FROM news_articles n
       WHERE n.published_at > NOW() - INTERVAL '24 hours'`
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

  // Build a map of ticker → yahoo_symbol from holdings table
  let symbolMap = {};
  try {
    const result = await db.query(
      `SELECT DISTINCT ON (ticker) ticker, yahoo_symbol
       FROM holdings WHERE ticker = ANY($1)`,
      [tickers]
    );
    for (const row of result.rows) {
      symbolMap[row.ticker] = row.yahoo_symbol;
    }
  } catch (err) {
    console.error('[nightlyRecap] DB error fetching yahoo symbols:', err.message);
  }

  console.log(`[nightlyRecap] Generating recaps for ${tickers.length} tickers`);
  const today = new Date().toISOString().slice(0, 10);

  for (const ticker of tickers) {
    // Skip if already generated
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

    // Fetch articles
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

    // Fetch price data
    const yahooSymbol = symbolMap[ticker] ?? ticker;
    const priceData   = await fetchPriceChange(yahooSymbol);
    if (priceData) {
      console.log(`[nightlyRecap] ${ticker} price: ${priceData.changePercent.toFixed(2)}%`);
    }

    const summary = await generateRecap(ticker, articles, priceData);
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
// Schedule: 8:00 PM ET every day
// ---------------------------------------------------------------------------

function schedule() {
  cron.schedule('0 20 * * *', runNightlyRecapJob, { timezone: 'America/New_York' });
  console.log('[nightlyRecap] Scheduled: daily at 8 PM ET');
}

module.exports = { schedule, runNightlyRecapJob };
