const axios = require('axios');

const BASE = 'https://api.polygon.io';

/**
 * Fetches recent news headlines from Polygon.io for the given stock/ETF tickers.
 * Returns raw headline objects filtered to the last `lookbackMinutes`.
 *
 * @param {string[]} tickers        - Stock/ETF display tickers, e.g. ['AAPL','SPY']
 * @param {number}   lookbackMinutes
 */
async function fetchPolygonNews(tickers, lookbackMinutes = 15) {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) {
    console.warn('[polygon] No API key set — skipping');
    return [];
  }

  // Only meaningful for stocks and ETFs
  const eligible = tickers.filter((t) => !isCrypto(t) && !isFuture(t));
  if (eligible.length === 0) return [];

  const cutoff = new Date(Date.now() - lookbackMinutes * 60 * 1000).toISOString();
  const results = [];

  // Polygon free tier: 5 req/min. Batch up to 5 tickers per call (ticker.any_of param).
  const BATCH = 5;
  for (let i = 0; i < eligible.length; i += BATCH) {
    const batch = eligible.slice(i, i + BATCH);
    try {
      const res = await axios.get(`${BASE}/v2/reference/news`, {
        params: {
          'ticker.any_of': batch.join(','),
          published_utc:   `gt:${cutoff}`,
          order:           'published_utc',
          sort:            'desc',
          limit:           20,
          apiKey,
        },
        timeout: 10000,
      });

      const articles = res.data?.results ?? [];
      for (const a of articles) {
        // Map each ticker mentioned back to a display ticker
        for (const t of (a.tickers ?? [])) {
          if (eligible.includes(t)) {
            results.push({
              ticker:    t,
              headline:  a.title,
              summary:   a.description ?? '',
              sourceUrl: a.article_url,
              source:    a.publisher?.name ?? 'Polygon',
              publishedAt: a.published_utc,
            });
          }
        }
      }
    } catch (err) {
      console.error('[polygon] Fetch error:', err.message);
    }

    // Respect 5 req/min rate limit on free tier
    if (i + BATCH < eligible.length) {
      await new Promise((r) => setTimeout(r, 12000));
    }
  }

  return results;
}

// Helpers — crude classification based on naming convention
function isCrypto(ticker) {
  return ['BTC','ETH','SOL','XRP','DOGE','ADA','AVAX'].includes(ticker);
}

function isFuture(ticker) {
  return ['GC','SI','CL','NG','HG','ZC','ZW'].includes(ticker);
}

module.exports = { fetchPolygonNews };
