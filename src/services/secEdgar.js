const axios = require('axios');

const BASE = 'https://efts.sec.gov/LATEST/search-index';

// User-Agent required by SEC EDGAR fair-use policy
function userAgent() {
  const email = process.env.SEC_CONTACT_EMAIL ?? 'contact@example.com';
  return `HODLApp/1.0 (${email})`;
}

/**
 * Searches SEC EDGAR full-text search for filings mentioning the given stock tickers.
 * Returns 8-K and S-1 filings from the last `lookbackMinutes`.
 *
 * Only meaningful for publicly-listed US equities. Crypto/commodity tickers are skipped.
 *
 * @param {string[]} tickers        - Stock/ETF display tickers
 * @param {number}   lookbackMinutes
 */
async function fetchSECFilings(tickers, lookbackMinutes = 15) {
  const stockTickers = tickers.filter(isStock);
  if (stockTickers.length === 0) return [];

  const cutoff = new Date(Date.now() - lookbackMinutes * 60 * 1000);
  const dateStr = cutoff.toISOString().slice(0, 10);  // YYYY-MM-DD
  const results = [];

  for (const ticker of stockTickers) {
    try {
      const res = await axios.get(`${BASE}`, {
        params: {
          q:          `"${ticker}"`,
          dateRange:  'custom',
          startdt:    dateStr,
          enddt:      new Date().toISOString().slice(0, 10),
          forms:      '8-K,S-1,10-Q,10-K',
          hits:       5,
        },
        headers: { 'User-Agent': userAgent() },
        timeout: 10000,
      });

      const hits = res.data?.hits?.hits ?? [];
      for (const hit of hits) {
        const s = hit._source ?? {};
        const filedAt = s.file_date ?? s.period_of_report;
        results.push({
          ticker,
          headline:    `${s.form_type ?? 'Filing'}: ${s.display_names ?? ticker} filed with the SEC`,
          summary:     s.period_of_report
            ? `Period: ${s.period_of_report}. ${s.entity_name ?? ''}`
            : (s.entity_name ?? ''),
          sourceUrl:   `https://www.sec.gov/Archives/edgar/data/${s.entity_id}/${s.file_num ?? ''}`,
          source:      'SEC EDGAR',
          publishedAt: filedAt,
          formType:    s.form_type,
        });
      }
    } catch (err) {
      console.error(`[secEdgar] Fetch error for ${ticker}:`, err.message);
    }

    // Polite delay between requests
    await new Promise((r) => setTimeout(r, 500));
  }

  return results;
}

function isStock(ticker) {
  const NON_STOCK = new Set([
    'BTC','ETH','SOL','XRP','DOGE','ADA','AVAX',    // crypto
    'GC','SI','CL','NG','HG','ZC','ZW',              // futures
    'SPY','QQQ','IWM','GLD','ARKK','VTI',            // ETFs (no 8-K)
  ]);
  return !NON_STOCK.has(ticker.toUpperCase());
}

module.exports = { fetchSECFilings };
