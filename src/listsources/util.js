'use strict';

// Shared text helpers for list sources. Every source returns entries shaped
// { title, author } that are display- and search-ready: subtitles and series
// noise stripped, casing natural, whitespace collapsed. The DEDUPE key logic
// (lists.entryKey) builds on cleanTitle/authorLastName so "Whistler: A Novel"
// (Amazon) and "WHISTLER" (NYT) resolve to the same book.

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on', 'or', 'so', 'the', 'to', 'up', 'yet']);

/** PURE: ALL-CAPS list titles ("THEO OF GOLDEN") → natural casing. Small
 *  connector words stay lowercase mid-title; hyphenated parts are cased per
 *  segment. Capitalizes at word start and after hyphens — NOT after
 *  apostrophes, which would mangle possessives ("Hitchhiker'S"). */
function titleCase(s) {
  const words = String(s || '').trim().toLowerCase().split(/\s+/);
  const cap = (w) => w.replace(/(^|-)(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
  return words
    .map((w, i) => (i > 0 && i < words.length - 1 && SMALL_WORDS.has(w) ? w : cap(w)))
    .join(' ');
}

/** PURE: strip retail/series noise from a title — "(Vipers Book 3)"-style
 *  parentheticals and everything after the first colon ("Whistler: A Novel" →
 *  "Whistler"). Rare legitimate colons lose their subtitle, which both search
 *  and dedupe prefer anyway. */
function cleanTitle(s) {
  return String(s || '')
    .replace(/\([^)]*\)/g, ' ')
    .split(':')[0]
    .replace(/\s+/g, ' ')
    .trim();
}

/** PURE: collapse runs of whitespace (Goodreads pads author names). */
function cleanAuthor(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** PURE: the first author's last name, lowercased — the author half of the
 *  dedupe key. Survives "A and B" / "A with B" collaborations, generational
 *  suffixes, and stray punctuation, so "Ann Patchett" keys the same however a
 *  list spells the byline. */
const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);
function authorLastName(s) {
  const first = cleanAuthor(s).split(/\s+(?:and|with|&)\s+|;|,/i)[0];
  const words = first.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').split(/\s+/).filter(Boolean);
  while (words.length > 1 && NAME_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words[words.length - 1] || '';
}

/** PURE: decode the handful of HTML entities that appear in scraped titles. */
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ');
}

// Scraped sources present as a plain browser; one request per pull.
const SCRAPE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

module.exports = { titleCase, cleanTitle, cleanAuthor, authorLastName, decodeEntities, SCRAPE_HEADERS };
