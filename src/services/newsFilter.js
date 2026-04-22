const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Pre-filter — discard obvious non-events by headline (no API calls).
// ---------------------------------------------------------------------------

const SKIP_PATTERNS = [
  /\d+\s+(stocks?|cryptos?|coins?|picks?|reasons?|ways?|tips?|things?)/i,
  /best\s+(stocks?|cryptos?|coins?|buys?|picks?)\s+(to buy|for|of|in)/i,
  /top\s+\d+/i,
  /should (you|i) (buy|sell|invest)/i,
  /is (it|now) a good time/i,
  /invest(ing|ment)\s+(guide|strategy|tip|advice)/i,
  /how to (invest|trade|buy|profit)/i,
  /beginner('s)?\s+(guide|tips?)/i,
  /portfolio\s+(advice|strategy|management|building|diversif)/i,
  /(better|best) buy.*(vs\.?|or)/i,
  /price (target|prediction|forecast) for \d{4}/i,
  /here'?s? why (you should|to (buy|sell))/i,
  /\b(undervalued|underrated|hidden gem)\b/i,
  /cathie wood (is buying|bought|owns)/i,
  /warren buffett (is buying|bought|owns)/i,
];

function preFilter(articles) {
  return articles.filter(({ headline, summary = '' }) => {
    const text = `${headline} ${summary}`;
    return !SKIP_PATTERNS.some((p) => p.test(text));
  });
}

// ---------------------------------------------------------------------------
// Batch relevance filter for holding-specific news.
// One Claude call per batch of 25 articles.
// ---------------------------------------------------------------------------

async function claudeBatchRelevanceCheck(articles) {
  if (articles.length === 0) return [];

  const list = articles
    .map((a, i) =>
      `${i + 1}. [${a.ticker}] ${a.headline}` +
      (a.summary ? `\n   Summary: ${a.summary.slice(0, 150)}` : '')
    )
    .join('\n\n');

  const prompt =
    `You are filtering news for a financial app. For each article below, decide if it ` +
    `contains specific factual information that would directly cause a trader to buy or sell — ` +
    `such as earnings results, guidance changes, executive moves, legal rulings, regulatory decisions, ` +
    `major partnerships, or product announcements. Exclude general market commentary, opinion pieces, ` +
    `portfolio advice, or articles that only mention the ticker in passing.\n\n` +
    `Reply with ONLY a JSON array of the numbers of articles that pass, e.g. [1,3,5]. ` +
    `If none pass, reply []. No other text.\n\nArticles:\n${list}`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    const text  = (response.content[0]?.text ?? '').trim();
    const match = text.match(/\[[\d,\s]*\]/);
    if (!match) { console.warn('[newsFilter] Unexpected batch response:', text); return []; }
    const indices  = JSON.parse(match[0]);
    const approved = indices.filter((n) => n >= 1 && n <= articles.length).map((n) => articles[n - 1]);
    console.log(`[newsFilter] Batch: ${approved.length}/${articles.length} approved`);
    return approved;
  } catch (err) {
    console.error('[newsFilter] Batch check error:', err.message);
    return [];
  }
}

async function claudeRelevanceFilter(articles) {
  const BATCH_SIZE = 25;
  const approved = [];
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const result = await claudeBatchRelevanceCheck(articles.slice(i, i + BATCH_SIZE));
    approved.push(...result);
  }
  return approved;
}

// ---------------------------------------------------------------------------
// Macro news filter — keeps only significant government/economic events.
// Strips out generic market commentary, opinion, and routine business news.
// ---------------------------------------------------------------------------

async function claudeMacroFilter(articles) {
  if (articles.length === 0) return [];
  const BATCH_SIZE = 25;
  const approved = [];

  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);
    const list  = batch
      .map((a, i) => `${i + 1}. ${a.headline}${a.summary ? '\n   ' + a.summary.slice(0, 150) : ''}`)
      .join('\n\n');

    const prompt =
      `You are filtering news for a financial app's "General News" section. ` +
      `This section is for BIG macro events that affect the entire market — ` +
      `NOT individual company news. Keep ONLY articles about:\n` +
      `- Federal Reserve decisions, interest rate changes, Fed speeches with new guidance\n` +
      `- Inflation data (CPI, PPI, PCE reports)\n` +
      `- Jobs reports, unemployment data\n` +
      `- GDP, recession signals, major economic data\n` +
      `- Government policy: tariffs, trade wars, sanctions, major legislation\n` +
      `- Geopolitical events: wars, invasions, major diplomatic crises affecting markets\n` +
      `- Banking crises, major financial system events\n` +
      `- OPEC decisions, major commodity supply shocks\n\n` +
      `Reject: individual company news, general market commentary, stock picks, opinion pieces, ` +
      `routine political news with no market impact.\n\n` +
      `Reply with ONLY a JSON array of passing article numbers, e.g. [1,3]. If none pass, reply []. No other text.\n\n` +
      `Articles:\n${list}`;

    try {
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 100,
        messages: [{ role: 'user', content: prompt }],
      });
      const text  = (response.content[0]?.text ?? '').trim();
      const match = text.match(/\[[\d,\s]*\]/);
      if (!match) continue;
      const indices = JSON.parse(match[0]);
      const passed  = indices.filter((n) => n >= 1 && n <= batch.length).map((n) => batch[n - 1]);
      console.log(`[newsFilter] Macro batch: ${passed.length}/${batch.length} approved`);
      approved.push(...passed);
    } catch (err) {
      console.error('[newsFilter] Macro filter error:', err.message);
    }
  }
  return approved;
}

// ---------------------------------------------------------------------------
// Breaking alert check — STRICT. Only flag if this would cause an immediate,
// significant price move (>3-5%) for that specific asset right now.
// Things like: surprise earnings, bankruptcy, major acquisition, emergency
// Fed action, bank failure, major sanctions on a specific crypto/company.
// Routine news, analyst upgrades, minor updates = NOT breaking.
// ---------------------------------------------------------------------------

async function claudeBreakingCheck(ticker, headline, summary) {
  const isMacro = ticker === 'MACRO';

  const prompt = isMacro
    ? `Is this a MAJOR market-moving macro event that every investor needs to know about RIGHT NOW? ` +
      `Examples that qualify: emergency Fed rate change, unexpected CPI shock, major country declaring war, ` +
      `sudden government shutdown, major bank failure. ` +
      `Routine data releases, political opinions, expected events = NOT breaking. ` +
      `Reply yes or no only.\n\nHeadline: ${headline}\nSummary: ${summary || '(none)'}`
    : `Is this news BREAKING for ${ticker} — meaning it would cause an immediate price move of 3% or more ` +
      `for this specific asset right now? ` +
      `Examples that qualify: surprise earnings beat/miss, bankruptcy filing, major acquisition announcement, ` +
      `sudden regulatory ban, exchange hack, CEO resignation under scandal. ` +
      `Analyst upgrades, minor partnerships, routine updates, general market moves = NOT breaking. ` +
      `Reply yes or no only.\n\nTicker: ${ticker}\nHeadline: ${headline}\nSummary: ${summary || '(none)'}`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 10,
      messages: [{ role: 'user', content: prompt }],
    });
    return (response.content[0]?.text ?? '').toLowerCase().trim().startsWith('yes');
  } catch (err) {
    console.error('[newsFilter] Breaking check error:', err.message);
    return false;
  }
}

module.exports = { preFilter, claudeRelevanceFilter, claudeMacroFilter, claudeBreakingCheck };
