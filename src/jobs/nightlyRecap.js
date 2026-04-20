const cron      = require('node-cron');
const db        = require('../config/db');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Macro tickers used to pull economy news
const MACRO_TICKERS = ['SPY', 'QQQ', 'TLT', 'DXY', 'GLD'];

// ---------------------------------------------------------------------------
// DB migration — add change_percent column if not present
// ---------------------------------------------------------------------------

async function ensureSchema() {
  await db.query(`ALTER TABLE daily_recaps ADD COLUMN IF NOT EXISTS change_percent NUMERIC`);
}

// ---------------------------------------------------------------------------
// Fetch today's price change from Yahoo Finance
// ---------------------------------------------------------------------------

async function fetchPriceChange(yahooSymbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1d&interval=1d`;
    const res  = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal:  AbortSignal.timeout(8000),
    });
    const json  = await res.json();
    const meta  = json?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const open  = meta.chartPreviousClose ?? meta.previousClose;
    const close = meta.regularMarketPrice ?? meta.postMarketPrice;
    if (!open || !close) return null;
    return { open, close, changePercent: ((close - open) / open) * 100 };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Generate a recap paragraph for a holding
// ---------------------------------------------------------------------------

async function generateRecap(ticker, articles, priceData) {
  const articleText = articles.length > 0
    ? articles.map((a, i) => `${i + 1}. ${a.headline}${a.summary ? ': ' + a.summary : ''}`).join('\n')
    : null;

  let priceContext = '';
  if (priceData) {
    const dir = priceData.changePercent >= 0 ? 'higher' : 'lower';
    const pct = Math.abs(priceData.changePercent).toFixed(2);
    priceContext = `Price data: ${ticker} closed ${dir} today at $${priceData.close.toFixed(2)} (${priceData.changePercent >= 0 ? '+' : ''}${priceData.changePercent.toFixed(2)}%).`;
  }

  if (!articleText && !priceContext) {
    return `It was a quiet day for ${ticker} — no major news or price movement today.`;
  }

  const prompt =
    `You are a financial analyst writing a brief daily recap for retail investors.\n` +
    `${priceContext}\n` +
    `${articleText ? `Today's news about ${ticker}:\n${articleText}\n` : ''}` +
    `\nWrite a single short paragraph (2-4 sentences) that:\n` +
    `1. States clearly whether ${ticker} closed higher or lower and by roughly how much\n` +
    `2. Explains the main reason(s) why based on the news\n` +
    `Be specific and direct. No bullet points. Do not start with "${ticker}:". Just the paragraph.`;

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 220,
      messages: [{ role: 'user', content: prompt }],
    });
    return (msg.content[0]?.text ?? '').trim();
  } catch (err) {
    console.error(`[nightlyRecap] Claude error for ${ticker}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Generate the U.S. Economy recap
// ---------------------------------------------------------------------------

async function generateEconomyRecap(articles, spyChange) {
  const articleText = articles.length > 0
    ? articles.map((a, i) => `${i + 1}. ${a.headline}${a.summary ? ': ' + a.summary : ''}`).join('\n')
    : 'No major economic headlines today.';

  let marketContext = '';
  if (spyChange) {
    const dir = spyChange.changePercent >= 0 ? 'higher' : 'lower';
    marketContext = `The S&P 500 (SPY) closed ${dir} today (${spyChange.changePercent >= 0 ? '+' : ''}${spyChange.changePercent.toFixed(2)}%).`;
  }

  const prompt =
    `You are a macroeconomic analyst writing a brief daily summary for retail investors.\n` +
    `${marketContext}\n` +
    `Today's economic and market news:\n${articleText}\n\n` +
    `Write a single short paragraph (3-5 sentences) summarizing what happened in the U.S. economy today ` +
    `that could affect investors. Cover things like: Federal Reserve news, interest rates, inflation, ` +
    `jobs data, geopolitical events, trade policy, or other macro forces. ` +
    `Be specific about what happened and why it matters for investors. No bullet points. Just the paragraph.`;

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 280,
      messages: [{ role: 'user', content: prompt }],
    });
    return (msg.content[0]?.text ?? '').trim();
  } catch (err) {
    console.error('[nightlyRecap] Claude error for US_ECONOMY:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core job
// ---------------------------------------------------------------------------

async function runNightlyRecapJob() {
  console.log('[nightlyRecap] Starting at', new Date().toISOString());
  await ensureSchema();

  const today     = new Date().toISOString().slice(0, 10);
  const dayOfWeek = new Date().getDay(); // 0=Sun, 6=Sat
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  // --- U.S. Economy recap (always, every day) ---
  try {
    const existing = await db.query(
      `SELECT id FROM daily_recaps WHERE ticker = 'US_ECONOMY' AND date = $1`, [today]
    );
    if (existing.rows.length === 0) {
      // Fetch macro news from SPY/QQQ/TLT/GLD + economy keywords
      const econArticles = await db.query(
        `SELECT DISTINCT headline, summary FROM news_articles
         WHERE (tickers && $1 OR
                lower(headline) ~ '(federal reserve|interest rate|inflation|gdp|jobs|unemployment|tariff|trade|recession|treasury|fiscal|geopolit|war|sanction|economy)')
           AND published_at > NOW() - INTERVAL '24 hours'
         ORDER BY headline LIMIT 10`,
        [MACRO_TICKERS]
      );
      const spyChange = await fetchPriceChange('SPY');
      const summary   = await generateEconomyRecap(econArticles.rows, spyChange);
      if (summary) {
        const pct = spyChange?.changePercent ?? null;
        await db.query(
          `INSERT INTO daily_recaps (ticker, date, summary, change_percent)
           VALUES ('US_ECONOMY', $1, $2, $3)
           ON CONFLICT (ticker, date) DO UPDATE SET summary = EXCLUDED.summary, change_percent = EXCLUDED.change_percent`,
          [today, summary, pct]
        );
        console.log('[nightlyRecap] ✓ US_ECONOMY');
      }
    }
  } catch (err) {
    console.error('[nightlyRecap] US_ECONOMY error:', err.message);
  }

  // --- Per-holding recaps ---
  let rows;
  try {
    const result = await db.query(
      `SELECT DISTINCT unnest(n.tickers) AS ticker
       FROM news_articles n
       WHERE n.published_at > NOW() - INTERVAL '24 hours'`
    );
    rows = result.rows.map((r) => r.ticker).filter((t) => t !== 'US_ECONOMY');
  } catch (err) {
    console.error('[nightlyRecap] DB error fetching tickers:', err.message);
    return;
  }

  // Build ticker → { yahoo_symbol, asset_type } map from holdings
  let assetMap = {};
  try {
    const result = await db.query(
      `SELECT DISTINCT ON (ticker) ticker, yahoo_symbol, asset_type FROM holdings WHERE ticker = ANY($1)`,
      [rows]
    );
    for (const r of result.rows) assetMap[r.ticker] = { yahooSymbol: r.yahoo_symbol, assetType: r.asset_type };
  } catch (err) {
    console.error('[nightlyRecap] DB error fetching asset info:', err.message);
  }

  // On weekends skip stocks — only process crypto and commodity
  const tickers = isWeekend
    ? rows.filter((t) => {
        const type = (assetMap[t]?.assetType ?? '').toLowerCase();
        return type === 'crypto' || type === 'commodity';
      })
    : rows;

  if (isWeekend) console.log(`[nightlyRecap] Weekend mode — skipping stocks, processing ${tickers.length} tickers`);

  console.log(`[nightlyRecap] Generating recaps for ${tickers.length} tickers`);

  for (const ticker of tickers) {
    try {
      const existing = await db.query(
        `SELECT id FROM daily_recaps WHERE ticker = $1 AND date = $2`, [ticker, today]
      );
      if (existing.rows.length > 0) { console.log(`[nightlyRecap] ${ticker} already done — skipping`); continue; }
    } catch (err) { console.error(`[nightlyRecap] DB check error for ${ticker}:`, err.message); continue; }

    let articles;
    try {
      const result = await db.query(
        `SELECT headline, summary FROM news_articles
         WHERE $1 = ANY(tickers) AND published_at > NOW() - INTERVAL '24 hours'
         ORDER BY published_at DESC LIMIT 8`,
        [ticker]
      );
      articles = result.rows;
    } catch (err) { console.error(`[nightlyRecap] DB fetch error for ${ticker}:`, err.message); continue; }

    const yahooSymbol = assetMap[ticker]?.yahooSymbol ?? ticker;
    const priceData   = await fetchPriceChange(yahooSymbol);
    if (priceData) console.log(`[nightlyRecap] ${ticker}: ${priceData.changePercent.toFixed(2)}%`);

    const summary = await generateRecap(ticker, articles, priceData);
    if (!summary) continue;

    try {
      await db.query(
        `INSERT INTO daily_recaps (ticker, date, summary, change_percent)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (ticker, date) DO UPDATE SET summary = EXCLUDED.summary, change_percent = EXCLUDED.change_percent`,
        [ticker, today, summary, priceData?.changePercent ?? null]
      );
      console.log(`[nightlyRecap] ✓ ${ticker}`);
    } catch (err) { console.error(`[nightlyRecap] DB insert error for ${ticker}:`, err.message); }
  }

  console.log('[nightlyRecap] Done at', new Date().toISOString());
}

function schedule() {
  cron.schedule('0 20 * * *', runNightlyRecapJob, { timezone: 'America/New_York' });
  console.log('[nightlyRecap] Scheduled: daily at 8 PM ET');
}

module.exports = { schedule, runNightlyRecapJob };
