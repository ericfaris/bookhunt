'use strict';

// Amazon "New Releases in Literature & Fiction" chart (issue #33 Phase 2).
// Scraped — markup-fragile by nature, so the parser is PURE (exported for
// tests against a fixture) and scoped per item: each book sits in an
// `id="p13n-asin-index-N"` container whose first two line-clamp spans are the
// title and the author, so a missing author can never misalign the pairing.
// A bot-check page parses to zero items, which fetch() reports as an error
// instead of treating the chart as suddenly empty.

const { cleanTitle, cleanAuthor, decodeEntities, SCRAPE_HEADERS } = require('./util');

const URL = 'https://www.amazon.com/gp/new-releases/books/17'; // Literature & Fiction node

/** PURE: chart HTML → [{ title, author }]. */
function parse(html) {
  const items = String(html || '').split(/id="p13n-asin-index-\d+"/).slice(1);
  const out = [];
  for (const item of items) {
    const spans = [...item.matchAll(/p13n-sc-css-line-clamp[^"]*">([^<]+)</g)].map((m) => m[1]);
    if (!spans.length) continue;
    const title = cleanTitle(decodeEntities(spans[0]));
    const author = cleanAuthor(decodeEntities(spans[1] || ''));
    if (title) out.push({ title, author });
  }
  return out;
}

async function fetchChart() {
  const res = await fetch(URL, { headers: SCRAPE_HEADERS, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Amazon chart responded ${res.status}`);
  const entries = parse(await res.text());
  if (!entries.length) throw new Error('Amazon chart parsed to 0 books — bot page or markup change');
  return entries;
}

function sources() {
  return [{
    id: 'amazon-new-releases-lit-fic',
    label: 'Amazon New Releases in Literature & Fiction',
    tag: 'Amazon New Releases',
    configured: true,
    fetch: fetchChart,
  }];
}

module.exports = { sources, parse, URL };
