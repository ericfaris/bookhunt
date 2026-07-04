'use strict';

// Display-title hygiene for the Library (and everything that reads it: the
// reader shelf, emails, sends). Download titles historically came straight
// from forum topic titles — "Theo of Golden by Allen Levi (.ePUB)", "- Shred
// Sisters", "2 Books by Kathryn Stockett (.ePUB)" — which read as scraper
// artifacts. This module reduces those to just the work's title, PURE and
// dependency-free so it's unit-testable and safe to call from history at
// ingest time (every download path funnels through history.logDownload).

// "(.ePUB)", "(ePUB, MOBI)", "[.PDF]"-style format tails, possibly repeated.
const FORMAT_TAIL_RE = /\s*[([]\s*\.?(?:epub|pdf|mobi|azw3?|m4b|mp3|retail)\b[^)\]]*[)\]]\s*$/i;

// Multi-book post titles ("2 Books by …", "3 novels by …") — there is no
// single real title inside them, so the filename is the better source.
const MULTIBOOK_RE = /^\d+\s+(?:e?books?|novels?|titles?)\b/i;

/** PURE: does this look like a junk/collection title rather than a book? */
function isJunkTitle(s) {
  return !String(s || '').trim() || MULTIBOOK_RE.test(String(s).trim());
}

/** PURE: "Title [Author] (2024).epub" → "Title" (null when no match). The
 *  filename is built from the ePUB's own metadata, so it's the most truthful
 *  title we hold. */
function titleFromFilename(filename) {
  const m = String(filename || '').match(/^(.+?)\s*\[[^\]]+\](?:\s*\(\d{4}\))?\.\w+$/);
  return m ? m[1].trim() : null;
}

/** PURE: gently title-case a string ONLY when it's clearly un-cased (every
 *  word after the first is all-lowercase — batch inputs like "broken country").
 *  Properly-cased titles ("The Someday Garden", "McConaghy") pass through. */
const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on', 'or', 'so', 'the', 'to', 'up', 'yet']);
function gentleTitleCase(s) {
  const words = String(s || '').split(/\s+/);
  const rest = words.slice(1);
  if (!rest.length || !rest.every((w) => w === w.toLowerCase())) return s;
  const cap = (w) => w.replace(/(^|-)(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
  return words
    .map((w, i) => (i > 0 && i < words.length - 1 && SMALL_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : cap(w)))
    .join(' ');
}

/**
 * PURE: the cleaned display title for a download entry.
 *   { title, author, filename } → best human title.
 * Order: strip artifacts from the stored title; if what's left is junk (a
 * "N Books by …" collection post or empty), fall back to the filename's
 * embedded-metadata title; finally, gently re-case all-lowercase input.
 */
function displayTitle({ title, author, filename } = {}) {
  let s = String(title || '')
    .replace(/^[\s\-–—•·]+/, '')     // leading batch/dash artifacts: "- Shred Sisters"
    .replace(/\s+/g, ' ')
    .trim();
  while (FORMAT_TAIL_RE.test(s)) s = s.replace(FORMAT_TAIL_RE, '').trim();
  // Trailing " by <author>" — only when it names THIS book's author (or when
  // the author is unknown), so titles that legitimately end in "by" survive.
  const by = s.match(/^(.*\S)\s+by\s+(.+)$/i);
  if (by) {
    const named = by[2].trim().toLowerCase();
    const a = String(author || '').trim().toLowerCase();
    if (a && (named === a || named.startsWith(a + ',') || a.startsWith(named))) s = by[1].trim();
    else if (!a && /^[\p{L}.'’\- ]+(?:,\s*[\p{L}.'’\- ]+)*$/u.test(by[2])) s = by[1].trim();
  }
  if (isJunkTitle(s)) {
    const fromFile = titleFromFilename(filename);
    // A collection post with no better source keeps its byline ("2 Books by
    // Kathryn Stockett" beats a bare "2 Books").
    s = fromFile || (by ? `${by[1].trim()} by ${by[2].trim()}` : s);
  }
  s = gentleTitleCase(s);
  return s || String(title || '').trim();
}

module.exports = { displayTitle, titleFromFilename, isJunkTitle, gentleTitleCase };
