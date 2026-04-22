const Parser = require('rss-parser');

const parser = new Parser({ timeout: 10000 });

// Macro-focused RSS feeds — government, economy, geopolitics
const MACRO_FEEDS = [
  { name: 'Reuters Business',  url: 'https://feeds.reuters.com/reuters/businessNews' },
  { name: 'Reuters Politics',  url: 'https://feeds.reuters.com/Reuters/PoliticsNews' },
  { name: 'CNBC Economy',      url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10001147' },
  { name: 'MarketWatch',       url: 'https://feeds.marketwatch.com/marketwatch/topstories/' },
  { name: 'WSJ Economy',       url: 'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines' },
  { name: 'AP Business',       url: 'https://feeds.apnews.com/apnews/business' },
];

// Keywords that signal a meaningful macro event (not generic market commentary)
const MACRO_KEYWORDS = [
  'federal reserve', 'fed rate', 'interest rate', 'rate cut', 'rate hike', 'rate decision',
  'inflation', 'cpi', 'ppi', 'pce', 'consumer price', 'producer price',
  'jobs report', 'unemployment', 'nonfarm payroll', 'labor market', 'jobless claims',
  'gdp', 'gross domestic product', 'recession', 'economic growth',
  'tariff', 'trade war', 'trade deal', 'import duty', 'export ban',
  'government shutdown', 'debt ceiling', 'federal budget', 'congress passed',
  'sanctions', 'geopolit', 'war', 'invasion', 'military strike', 'ceasefire',
  'treasury yield', 'bond yield', '10-year yield', 'yield curve',
  'bank failure', 'banking crisis', 'fdic', 'bailout',
  'powell', 'yellen', 'imf', 'world bank', 'opec',
  'oil price', 'energy crisis', 'supply chain',
  'white house', 'executive order', 'president signed', 'congress',
  'sec ruling', 'doj', 'antitrust', 'regulation',
];

/**
 * Fetches macro/economic/geopolitical news from public RSS feeds.
 * Returns articles tagged with ticker = 'MACRO'.
 *
 * @param {number} lookbackMinutes
 * @returns {Promise<object[]>}
 */
async function fetchMacroNews(lookbackMinutes = 60) {
  const cutoffMs = Date.now() - lookbackMinutes * 60 * 1000;
  const results  = [];

  const feedResults = await Promise.allSettled(
    MACRO_FEEDS.map((feed) => parser.parseURL(feed.url).then((data) => ({ feed, data })))
  );

  for (const result of feedResults) {
    if (result.status === 'rejected') {
      console.warn('[macroNews] Feed failed:', result.reason?.message);
      continue;
    }

    const { feed, data } = result.value;
    for (const item of data.items ?? []) {
      const pubDate = item.pubDate ? new Date(item.pubDate).getTime() : 0;
      if (pubDate < cutoffMs) continue;

      const text = `${(item.title ?? '').toLowerCase()} ${(item.contentSnippet ?? '').toLowerCase()}`;

      // Only keep articles that mention at least one macro keyword
      const isMacro = MACRO_KEYWORDS.some((kw) => text.includes(kw));
      if (!isMacro) continue;

      results.push({
        ticker:      'MACRO',
        headline:    item.title ?? '',
        summary:     item.contentSnippet ?? '',
        sourceUrl:   item.link ?? '',
        source:      feed.name,
        publishedAt: item.pubDate ?? new Date().toISOString(),
      });
    }
  }

  // Deduplicate by headline
  const seen = new Set();
  return results.filter(({ headline }) => {
    if (seen.has(headline)) return false;
    seen.add(headline);
    return true;
  });
}

module.exports = { fetchMacroNews };
