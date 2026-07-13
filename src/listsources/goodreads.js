'use strict';

// Goodreads genre pages (issue #33 Phase 2, revised): two adult-fiction genre
// pages — "most read" (popularity signal) and "new releases" (recency signal).
// Unlike the old monthly page, these are server-rendered with no embedded
// Apollo/JSON blob. Instead each book cover carries a prototip tooltip as an
// escaped JS string literal inside a `new Tip($('bookCoverNNN_ID'), "...", ...)`
// call in a <script> block. The escaped HTML in that string holds the title
// (a.readable.bookTitle anchor) and author(s) (a.authorName anchor(s)). We
// regex the escaped argument out, unescape the JS string, then pull title/author
// from the anchors. Following the NYT pattern, the two pages are two separate
// sources sharing one fetch/parse helper (parameterized by URL only — the markup
// is identical between them). The parser is PURE for tests.

const { cleanTitle, cleanAuthor, decodeEntities, SCRAPE_HEADERS } = require('./util');

const PAGES = [
  { id: 'goodreads-most-read-adult-fiction', label: 'Goodreads Most Read (Adult Fiction)', url: 'https://www.goodreads.com/genres/most_read/adult-fiction' },
  { id: 'goodreads-new-releases-adult-fiction', label: 'Goodreads New Releases (Adult Fiction)', url: 'https://www.goodreads.com/genres/new_releases/adult-fiction' },
];

/** PURE: unescape a JS double-quoted string literal's body. Handles \" \/ \'
 *  \\ and turns \n/\t into a space (whitespace is later collapsed by
 *  cleanTitle/cleanAuthor). NOT JSON.parse — the page uses \' which is not
 *  valid JSON and would throw. */
function unescapeJsString(s) {
  return String(s || '').replace(/\\(.)/g, (m, c) => (c === 'n' || c === 't' ? ' ' : c));
}

/** PURE: genre-page HTML → [{ title, author }]. Returns [] on a page with no
 *  Tip blocks (bot page / markup change); the fetch wrapper turns that into a
 *  thrown error. */
function parse(html) {
  // Escape-aware capture of each Tip's second argument: a naive "([^"]*)" would
  // terminate at the first \" inside the tooltip HTML (titles/blurbs have quotes).
  const tipRe = /new Tip\(\$\('bookCover[^']*'\),\s*"((?:[^"\\]|\\.)*)"/g;
  const out = [];
  let m;
  while ((m = tipRe.exec(html)) !== null) {
    const block = unescapeJsString(m[1]);
    const titleM = block.match(/class="readable bookTitle"[^>]*>([^<]+)</);
    if (!titleM) continue;
    const title = cleanTitle(decodeEntities(titleM[1]));
    if (!title) continue;
    // Co-authored books have multiple authorName anchors — take the first only,
    // matching how authorLastName keys multi-author bylines by the first author.
    const authorM = block.match(/class="authorName"[^>]*>([^<]+)</);
    const author = cleanAuthor(decodeEntities(authorM ? authorM[1] : ''));
    out.push({ title, author });
  }
  return out;
}

async function fetchGenrePage(url) {
  const res = await fetch(url, { headers: SCRAPE_HEADERS, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Goodreads responded ${res.status} for ${url}`);
  const entries = parse(await res.text());
  if (!entries.length) throw new Error(`Goodreads parsed to 0 books for ${url} — bot page or markup change`);
  return entries;
}

function sources() {
  return PAGES.map((p) => ({
    id: p.id,
    label: p.label,
    tag: 'Goodreads Adult Fiction',
    configured: true,
    fetch: () => fetchGenrePage(p.url),
  }));
}

module.exports = { sources, parse, unescapeJsString, fetchGenrePage, PAGES };
