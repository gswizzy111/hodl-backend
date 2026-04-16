const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Pre-filter — no Claude needed. Discard obvious non-events by headline.
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
// Batch relevance check — one Claude call for up to 30 articles at once.
// Returns the subset of articles that are relevant.
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
    `You are filtering news articles for a financial app. For each article below, decide if it ` +
    `contains specific factual information that would directly cause a trader to buy or sell — ` +
    `such as earnings results, guidance changes, executive moves, legal rulings, regulatory decisions, ` +
    `major partnerships, or product announcements. Exclude general market commentary, opinion pieces, ` +
    `portfolio advice, or articles that only mention the ticker in passing.\n\n` +
    `Reply with ONLY a JSON array of the numbers of articles that pass, e.g. [1,3,5]. ` +
    `If none pass, reply []. No other text.\n\n` +
    `Articles:\n${list}`;

  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages:   [{ role: 'user', content: prompt }],
    });

    const text = (response.content[0]?.text ?? '').trim();
    const match = text.match(/\[[\d,\s]*\]/);
    if (!match) {
      console.warn('[newsFilter] Unexpected batch response:', text);
      return [];
    }
    const indices = JSON.parse(match[0]);
    const approved = indices
      .filter((n) => n >= 1 && n <= articles.length)
      .map((n) => articles[n - 1]);
    console.log(`[newsFilter] Batch: ${approved.length}/${articles.length} approved`);
    return approved;
  } catch (err) {
    console.error('[newsFilter] Batch check error:', err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API — filters an array of articles, batching into groups of 25.
// ---------------------------------------------------------------------------

async function claudeRelevanceFilter(articles) {
  const BATCH_SIZE = 25;
  const approved = [];
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);
    const result = await claudeBatchRelevanceCheck(batch);
    approved.push(...result);
  }
  return approved;
}

// ---------------------------------------------------------------------------
// Breaking alert check — stricter prompt for push-worthy events only.
// ---------------------------------------------------------------------------

async function claudeBreakingCheck(ticker, headline, summary) {
  const prompt =
    `Is this event significant enough to send a push notification to an investor — meaning it is ` +
    `a sudden material development that would cause most traders to immediately reconsider their ` +
    `position? Reply yes or no only.\n\n` +
    `Ticker: ${ticker}\n` +
    `Headline: ${headline}\n` +
    `Summary: ${summary || '(no summary)'}`;

  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages:   [{ role: 'user', content: prompt }],
    });
    const text = (response.content[0]?.text ?? '').toLowerCase().trim();
    return text.startsWith('yes');
  } catch (err) {
    console.error('[newsFilter] Breaking check error:', err.message);
    return false;
  }
}

module.exports = { preFilter, claudeRelevanceFilter, claudeBreakingCheck };
