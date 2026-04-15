const axios = require('axios');

const BASE = 'https://api.whale-alert.io/v1';

// Tickers whale-alert supports (mapped to our display tickers)
const CRYPTO_SYMBOLS = {
  bitcoin:  'BTC',
  ethereum: 'ETH',
  solana:   'SOL',
  xrp:      'XRP',
  dogecoin: 'DOGE',
  cardano:  'ADA',
  avalanche: 'AVAX',
  usdt:     'USDT',
  usdc:     'USDC',
};

/**
 * Fetches whale transactions from the last `lookbackSeconds` seconds.
 * Returns an array of { ticker, headline, summary, sourceUrl } objects
 * for transactions >= $500k USD value.
 *
 * @param {string[]} tickers - Display tickers we care about (e.g. ['BTC','ETH'])
 * @param {number}   lookbackSeconds - How far back to look (default 900 = 15 min)
 */
async function fetchWhaleAlerts(tickers, lookbackSeconds = 900) {
  const apiKey = process.env.WHALE_ALERT_API_KEY;
  if (!apiKey) {
    console.warn('[whaleAlert] No API key set — skipping');
    return [];
  }

  const since = Math.floor(Date.now() / 1000) - lookbackSeconds;

  let transactions = [];
  try {
    const res = await axios.get(`${BASE}/transactions`, {
      params: {
        api_key: apiKey,
        min_value: 500000,   // $500k USD minimum
        start: since,
        limit: 100,
      },
      timeout: 8000,
    });
    transactions = res.data?.result ?? [];
  } catch (err) {
    console.error('[whaleAlert] Fetch error:', err.message);
    return [];
  }

  const tickerSet = new Set(tickers.map((t) => t.toUpperCase()));
  const alerts = [];

  for (const tx of transactions) {
    const symbol = tx.symbol?.toLowerCase();
    const displayTicker = CRYPTO_SYMBOLS[symbol];
    if (!displayTicker || !tickerSet.has(displayTicker)) continue;

    const amount = tx.amount?.toLocaleString('en-US', { maximumFractionDigits: 0 }) ?? '?';
    const usdValue = tx.amount_usd
      ? `$${(tx.amount_usd / 1e6).toFixed(1)}M`
      : 'unknown USD value';
    const from = tx.from?.owner_type === 'exchange' ? tx.from.owner : 'unknown wallet';
    const to   = tx.to?.owner_type   === 'exchange' ? tx.to.owner   : 'unknown wallet';

    alerts.push({
      ticker:    displayTicker,
      headline:  `🐋 Whale moved ${amount} ${displayTicker} (${usdValue})`,
      summary:   `From ${from} → ${to}. Transaction hash: ${tx.hash?.slice(0, 12)}…`,
      sourceUrl: `https://whale-alert.io`,
      source:    'Whale Alert',
      rawValue:  tx.amount_usd ?? 0,
    });
  }

  return alerts;
}

module.exports = { fetchWhaleAlerts };
