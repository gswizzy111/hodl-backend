const cron = require('node-cron');
const db   = require('../config/db');
const { fetchPolygonNews }      = require('../services/polygon');
const { fetchCryptoRSSNews }    = require('../services/rssNews');
const { preFilter, claudeRelevanceFilter, claudeBreakingCheck } = require('../services/newsFilter');

const LOOKBACK_HOURS  = 24;
const LOOKBACK_MINUTES = LOOKBACK_HOURS * 60;

const CRYPTO_TICKERS = new Set([
  'BTC','ETH','SOL','XRP','DOGE','ADA','AVAX','LINK','BNB','MATIC','DOT',
]);

// ---------------------------------------------------------------------------
// Core refresh logic — shared by cron job and on-demand API endpoint
// ---------------------------------------------------------------------------

/**
 * Fetches, pre-filters, Claude-checks, and stores news for the given tickers.
 * Returns all approved articles from the DB for those tickers.
 *
 * @param {string[]} tickers  e.g. ['BTC','ETH','AAPL']
 * @returns {Promise<object[]>} approved article rows
 */
async function refreshNewsForTickers(tickers) {
  if (!tickers || tickers.length === 0) return [];

  const stocks = tickers.filter((t) => !CRYPTO_TICKERS.has(t.toUpperCase()));
  const crypto = tickers.filter((t) =>  CRYPTO_TICKERS.has(t.toUpperCase()));

  console.log(`[newsRefresh] Fetching for stocks: [${stocks}] crypto: [${crypto}]`);

  const [polygonArticles, rssArticles] = await Promise.all([
    stocks.length > 0 ? fetchPolygonNews(stocks, LOOKBACK_MINUTES) : [],
    crypto.length > 0 ? fetchCryptoRSSNews(crypto, LOOKBACK_MINUTES) : [],
  ]);

  const raw = [...polygonArticles, ...rssArticles];
  if (raw.length === 0) {
    console.log('[newsRefresh] No raw articles fetched');
    return getArticlesForTickers(tickers);
  }
  console.log(`[newsRefresh] ${raw.length} raw articles`);

  // Step 1: Pre-filter obvious non-events (no API calls)
  const preFiltered = preFilter(raw);
  console.log(`[newsRefresh] ${preFiltered.length} after pre-filter`);

  // Step 2: Find articles NOT already in the DB — skip re-checking with Claude
  const headlineSet = await getExistingHeadlines(preFiltered.map((a) => a.headline));
  const newArticles  = preFiltered.filter((a) => !headlineSet.has(a.headline));
  const seen         = preFiltered.filter((a) =>  headlineSet.has(a.headline));
  console.log(`[newsRefresh] ${newArticles.length} new | ${seen.length} already cached`);

  // Step 3: Claude batch relevance filter — one API call for all new articles
  const approvedArticles = await claudeRelevanceFilter(newArticles);
  for (const article of approvedArticles) {
    await storeArticle(article);
    // Step 3b: Breaking check — is this push-worthy?
    const isBreaking = await claudeBreakingCheck(article.ticker, article.headline, article.summary);
    await markBreakingChecked(article.headline, isBreaking);
    if (isBreaking) console.log(`[newsRefresh] BREAKING: ${article.headline.slice(0, 60)}`);
  }

  // Step 4: For articles already in the DB, ensure ticker is added + run breaking
  //         check if not yet checked (handles articles stored before this feature existed)
  const unchecked = await getUncheckedArticles(seen.map((a) => a.headline));
  if (unchecked.length > 0) {
    console.log(`[newsRefresh] Breaking-checking ${unchecked.length} previously unchecked articles`);
    for (const row of unchecked) {
      const isBreaking = await claudeBreakingCheck(row.tickers[0], row.headline, row.summary);
      await markBreakingChecked(row.headline, isBreaking);
      if (isBreaking) console.log(`[newsRefresh] BREAKING (retroactive): ${row.headline.slice(0, 60)}`);
    }
  }
  for (const article of seen) {
    await addTickerToArticle(article.headline, article.ticker);
  }

  // Step 5: Expire articles older than 24 hours
  const deleted = await db.query(
    `DELETE FROM news_articles WHERE published_at < NOW() - INTERVAL '24 hours'`
  );
  if (deleted.rowCount > 0) {
    console.log(`[newsRefresh] Expired ${deleted.rowCount} old articles`);
  }

  return getArticlesForTickers(tickers);
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function getExistingHeadlines(headlines) {
  if (headlines.length === 0) return new Set();
  const result = await db.query(
    `SELECT headline FROM news_articles WHERE headline = ANY($1)`,
    [headlines]
  );
  return new Set(result.rows.map((r) => r.headline));
}

async function storeArticle(article) {
  try {
    await db.query(
      `INSERT INTO news_articles (tickers, headline, summary, source, article_url, published_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (headline) DO UPDATE
         SET tickers = array(SELECT DISTINCT unnest(news_articles.tickers || $1::text[]))`,
      [
        [article.ticker],
        article.headline,
        article.summary    || '',
        article.source     || '',
        article.sourceUrl  || '',
        article.publishedAt || new Date().toISOString(),
      ]
    );
  } catch (err) {
    console.error('[newsRefresh] storeArticle error:', err.message);
  }
}

async function markBreakingChecked(headline, isBreaking) {
  try {
    await db.query(
      `UPDATE news_articles SET is_breaking = $1, breaking_checked = TRUE WHERE headline = $2`,
      [isBreaking, headline]
    );
  } catch (err) {
    console.error('[newsRefresh] markBreakingChecked error:', err.message);
  }
}

async function getUncheckedArticles(headlines) {
  if (headlines.length === 0) return [];
  try {
    const result = await db.query(
      `SELECT headline, summary, tickers FROM news_articles
       WHERE headline = ANY($1) AND breaking_checked = FALSE`,
      [headlines]
    );
    return result.rows;
  } catch (err) {
    console.error('[newsRefresh] getUnchecked error:', err.message);
    return [];
  }
}

async function addTickerToArticle(headline, ticker) {
  try {
    await db.query(
      `UPDATE news_articles
       SET tickers = array(SELECT DISTINCT unnest(tickers || $1::text[]))
       WHERE headline = $2`,
      [[ticker], headline]
    );
  } catch (err) {
    console.error('[newsRefresh] addTicker error:', err.message);
  }
}

/**
 * Returns all DB-cached approved articles for the given tickers, newest first.
 */
async function getArticlesForTickers(tickers) {
  if (!tickers || tickers.length === 0) return [];
  try {
    const result = await db.query(
      `SELECT id, tickers, headline, summary, source, article_url, published_at
       FROM news_articles
       WHERE tickers && $1::text[]
         AND published_at > NOW() - INTERVAL '24 hours'
       ORDER BY published_at DESC`,
      [tickers.map((t) => t.toUpperCase())]
    );
    return result.rows;
  } catch (err) {
    console.error('[newsRefresh] getArticles error:', err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Cron schedule — runs every 30 min to keep the cache warm for all users
// ---------------------------------------------------------------------------

function schedule() {
  cron.schedule('*/20 * * * *', async () => {
    console.log('[newsRefresh] Cron run at', new Date().toISOString());
    try {
      const result = await db.query('SELECT DISTINCT ticker FROM holdings');
      const tickers = result.rows.map((r) => r.ticker);
      if (tickers.length > 0) await refreshNewsForTickers(tickers);
    } catch (err) {
      console.error('[newsRefresh] Cron error:', err.message);
    }
  });
  console.log('[newsRefresh] Scheduled: every 30 min');
}

module.exports = { refreshNewsForTickers, getArticlesForTickers, schedule };
