'use strict';

// Goodreads "popular books by release date" for the current month (issue #33
// Phase 2). No public API anymore, but the page embeds its Apollo cache in a
// __NEXT_DATA__ JSON blob — parsed as real JSON, not regex-scraped markup, so
// this is sturdier than it sounds. Each Book node links its author through
// primaryContributorEdge → Contributor. The parser is PURE for tests.

const { cleanTitle, cleanAuthor, SCRAPE_HEADERS } = require('./util');

function monthUrl(date = new Date()) {
  return `https://www.goodreads.com/book/popular_by_date/${date.getUTCFullYear()}/${date.getUTCMonth() + 1}`;
}

/** PURE: page HTML → [{ title, author }]. Throws on unparseable structure. */
function parse(html) {
  const m = String(html || '').match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (!m) throw new Error('Goodreads page has no __NEXT_DATA__ — markup change');
  const apollo = JSON.parse(m[1]).props.pageProps.apolloState;
  const out = [];
  for (const [key, node] of Object.entries(apollo)) {
    if (!key.startsWith('Book:') || !node || !node.titleComplete) continue;
    const ref = node.primaryContributorEdge && node.primaryContributorEdge.node && node.primaryContributorEdge.node.__ref;
    const contributor = (ref && apollo[ref]) || {};
    const title = cleanTitle(node.titleComplete);
    if (title) out.push({ title, author: cleanAuthor(contributor.name || '') });
  }
  return out;
}

async function fetchMonth() {
  const res = await fetch(monthUrl(), { headers: SCRAPE_HEADERS, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Goodreads responded ${res.status}`);
  const entries = parse(await res.text());
  if (!entries.length) throw new Error('Goodreads parsed to 0 books — markup change');
  return entries;
}

function sources() {
  return [{
    id: 'goodreads-popular-this-month',
    label: 'Goodreads Popular This Month',
    tag: 'Goodreads Popular',
    configured: true,
    fetch: fetchMonth,
  }];
}

module.exports = { sources, parse, monthUrl };
