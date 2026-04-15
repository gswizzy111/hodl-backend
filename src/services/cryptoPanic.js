const axios = require('axios');

const BASE = 'https://cryptopanic.com/api/v1';

/**
 * Fetches recent crypto news from CryptoPanic for the given crypto tickers.
 * Filters to "hot" or "important" posts published in the last `lookbackMinutes`.
 *
 * @param {string[]} tickers        - Crypto display tickers, e.g. ['BTC','ETH','SOL']
 * @param {number}   lookbackMinutes
 */
async function fetchCryptoPanicNews(tickers, lookbackMinutes = 15) {
  const apiKey = process.env.CRYPTOPANIC_API_KEY;
  if (!apiKey) {
    console.warn('[cryptoPanic] No API key set — skipping');
    return [];
  }

  // CryptoPanic uses the actual coin symbol directly
  const cryptoTickers = tickers.filter(isCrypto);
  if (cryptoTickers.length === 0) return [];

  const cutoffMs = Date.now() - lookbackMinutes * 60 * 1000;
  const results = [];

  try {
    const res = await axios.get(`${BASE}/posts/`, {
      params: {
        auth_token:  apiKey,
        currencies:  cryptoTickers.join(','),
        filter:      'hot',       // hot | rising | bullish | bearish | important | saved | lol
        public:      'true',
        kind:        'news',
      },
      timeout: 8000,
    });

    const posts = res.data?.results ?? [];
    for (const post of posts) {
      const publishedAt = new Date(post.published_at).getTime();
      if (publishedAt < cutoffMs) continue;  // too old

      // Map the post's currencies back to our tickers
      const mentionedTickers = (post.currencies ?? [])
        .map((c) => c.code?.toUpperCase())
        .filter((c) => cryptoTickers.includes(c));

      for (const ticker of mentionedTickers) {
        results.push({
          ticker,
          headline:    post.title,
          summary:     '',         // CryptoPanic free tier doesn't include article body
          sourceUrl:   post.url,
          source:      post.source?.title ?? 'CryptoPanic',
          publishedAt: post.published_at,
          votes:       post.votes ?? {},
        });
      }
    }
  } catch (err) {
    console.error('[cryptoPanic] Fetch error:', err.message);
  }

  return results;
}

function isCrypto(ticker) {
  // Any ticker with a known crypto symbol — extend as needed
  const CRYPTO_TICKERS = new Set(['BTC','ETH','SOL','XRP','DOGE','ADA','AVAX','USDT','USDC','BNB','MATIC','LINK','DOT','SHIB']);
  return CRYPTO_TICKERS.has(ticker.toUpperCase());
}

module.exports = { fetchCryptoPanicNews };
