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
// Claude relevance check — yes/no only, uses Haiku for speed and cost.
// ---------------------------------------------------------------------------

async function claudeRelevanceCheck(ticker, headline, summary) {
  const prompt =
    `Here is a news article about ${ticker}. Does this article contain specific factual ` +
    `information that would directly cause a trader to buy or sell this asset — such as earnings ` +
    `results, guidance changes, executive moves, legal rulings, regulatory decisions, major ` +
    `partnerships, or product announcements? Ignore general market commentary, portfolio advice, ` +
    `or articles that just mention the ticker in passing. Reply yes or no only.\n\n` +
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
    console.error('[newsFilter] Claude check error:', err.message);
    return false; // fail closed — don't show unverified articles
  }
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

module.exports = { preFilter, claudeRelevanceCheck, claudeBreakingCheck };
