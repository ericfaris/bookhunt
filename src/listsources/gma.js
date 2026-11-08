'use strict';

// GMA Book Club picks (Good Morning America, ABC News). One shop article holds
// the running list, updated in place each month, so one URL covers the whole
// history. Each pick is a product promo embed whose ecm_object_id is
// "<articleId>-<n>", counting up from -3 (newest first). The embed's title is
// "Title by Author" (or "Title" alone), the same text as the visible headline.
// The promos after the monthly run (-41 on) are a separate best-of section, so
// the parser stops at the first gap in the sequence. Scraped (no API); the fetch
// wrapper turns a zero-pick parse into an error so the radar just skips it.
// The parser is PURE for tests.

const { cleanTitle, cleanAuthor, decodeEntities, SCRAPE_HEADERS } = require('./util');

const URL = 'https://www.goodmorningamerica.com/news/story/shop-gma-book-club-picks-list--81520726';
const ARTICLE_ID = '81520726';

// Only the most recent picks are watched (one per month, so 12 ≈ a year). The
// article goes back to 2024; a first pull would otherwise auto-watch the whole
// backlog. The seen-map keeps anything already processed from being re-added.
const MAX_MONTHS = 12;

const PROMO_RE = new RegExp(
  '"ecm_item_title":"([^"]*)","ecm_item_type":"[^"]*","ecm_brand":"[^"]*","ecm_url":"[^"]*","ecm_object_id":"' + ARTICLE_ID + '-(\\d+)"',
  'g'
);

/** PURE: one headline string ("Title by Author", possibly with a "GMA Book
 *  Club Pick" tag or a quoted title) → { title, author } or null. */
function parseHeadline(raw) {
  let s = decodeEntities(String(raw || '')).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  let author = '';
  const byIdx = s.lastIndexOf(' by ');
  if (byIdx > 0) {
    author = s.slice(byIdx + 4);
    s = s.slice(0, byIdx);
  }
  s = s.replace(/:\s*A GMA Book Club Pick$/i, '').replace(/\s+A GMA Book Club Pick$/i, '');
  s = s.replace(/\s+A Novel$/i, '');
  // Quoted titles ("The List", 'Happiness Falls') come wrapped in quote marks.
  s = s.replace(/^["'“‘]+(.*?)["'”’]+$/, '$1').trim();
  const title = cleanTitle(s);
  if (!title) return null;
  return { title, author: cleanAuthor(author) };
}

/** PURE: GMA shop-article HTML → [{ title, author }] for the most recent
 *  MAX_MONTHS picks, newest first. Stops at the first gap in the promo
 *  sequence so the best-of section below the monthly run is ignored. Returns
 *  [] when no monthly picks parse. */
function parse(html) {
  const src = String(html || '');
  const picks = [];
  let expected = null;
  let m;
  PROMO_RE.lastIndex = 0;
  while ((m = PROMO_RE.exec(src)) !== null) {
    const n = Number(m[2]);
    if (expected === null) {
      if (n !== 3) break;
    } else if (n !== expected) {
      break;
    }
    expected = n + 1;
    const entry = parseHeadline(m[1]);
    if (entry) picks.push(entry);
    if (picks.length >= MAX_MONTHS) break;
  }
  return picks;
}

async function fetchPicks() {
  const res = await fetch(URL, { headers: SCRAPE_HEADERS, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`GMA responded ${res.status} for ${URL}`);
  const entries = parse(await res.text());
  if (!entries.length) throw new Error('GMA Book Club parsed to 0 picks — markup change');
  return entries;
}

function sources() {
  return [{
    id: 'gma-book-club',
    label: 'GMA Book Club',
    tag: 'GMA Book Club',
    configured: true,
    priority: 2, // curated monthly pick — after NYT, ahead of Goodreads Most Read
    fetch: fetchPicks,
  }];
}

module.exports = { sources, parse, parseHeadline, fetchPicks, MAX_MONTHS, URL, PROMO_RE };
