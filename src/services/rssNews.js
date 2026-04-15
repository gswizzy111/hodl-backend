const Parser = require('rss-parser');

const parser = new Parser({ timeout: 10000 });

// Free public RSS feeds from major crypto news outlets
const CRYPTO_FEEDS = [
  { name: 'CoinDesk',       url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'CoinTelegraph',  url: 'https://cointelegraph.com/rss' },
  { name: 'Decrypt',        url: 'https://decrypt.co/feed' },
  { name: 'The Block',      url: 'https://www.theblock.co/rss.xml' },
  { name: 'CryptoSlate',    url: 'https://cryptoslate.com/feed/' },
  { name: 'BeInCrypto',     url: 'https://beincrypto.com/feed/' },
];

// Maps keywords found in article titles to display tickers
const TICKER_KEYWORDS = {
  BTC:  ['bitcoin', 'btc'],
  ETH:  ['ethereum', 'eth', 'ether'],
  SOL:  ['solana', 'sol'],
  XRP:  ['xrp', 'ripple'],
  DOGE: ['dogecoin', 'doge'],
  ADA:  ['cardano', 'ada'],
  AVAX: ['avalanche', 'avax'],
  LINK: ['chainlink', 'link'],
  BNB:  ['bnb', 'binance coin'],
  MATIC:['polygon', 'matic'],
  DOT:  ['polkadot', 'dot'],
};

/**
 * Fetches recent crypto news from free RSS feeds.
 * Replaces CryptoPanic — same output format, no API key required.
 *
 * @param {string[]} tickers        - Crypto tickers the user holds, e.g. ['BTC','ETH']
 * @param {number}   lookbackMinutes - How far back to look (default 15 min)
 */
async function fetchCryptoRSSNews(tickers, lookbackMinutes = 15) {
  const cryptoTickers = tickers.filter((t) => TICKER_KEYWORDS[t.toUpperCase()]);
  if (cryptoTickers.length === 0) return [];

  const cutoffMs = Date.now() - lookbackMinutes * 60 * 1000;
  const results  = [];

  // Fetch all feeds in parallel
  const feedResults = await Promise.allSettled(
    CRYPTO_FEEDS.map((feed) => parser.parseURL(feed.url).then((data) => ({ feed, data })))
  );

  for (const result of feedResults) {
    if (result.status === 'rejected') {
      console.warn('[rssNews] Feed failed:', result.reason?.message);
      continue;
    }

    const { feed, data } = result.value;
    const items = data.items ?? [];

    for (const item of items) {
      // Skip articles older than the lookback window
      const pubDate = item.pubDate ? new Date(item.pubDate).getTime() : 0;
      if (pubDate < cutoffMs) continue;

      const titleLower = (item.title ?? '').toLowerCase();
      const descLower  = (item.contentSnippet ?? item.summary ?? '').toLowerCase();
      const text       = `${titleLower} ${descLower}`;

      // Check which of the user's held tickers are mentioned
      for (const ticker of cryptoTickers) {
        const keywords = TICKER_KEYWORDS[ticker.toUpperCase()] ?? [];
        const mentioned = keywords.some((kw) => text.includes(kw));
        if (!mentioned) continue;

        results.push({
          ticker,
          headline:    item.title ?? '',
          summary:     item.contentSnippet ?? '',
          sourceUrl:   item.link ?? '',
          source:      feed.name,
          publishedAt: item.pubDate ?? new Date().toISOString(),
        });
      }
    }
  }

  // Deduplicate by headline (same story can appear across multiple feeds)
  const seen = new Set();
  return results.filter(({ headline }) => {
    if (seen.has(headline)) return false;
    seen.add(headline);
    return true;
  });
}

module.exports = { fetchCryptoRSSNews };
