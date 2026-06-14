'use strict';

// Book-cover lookup for the Library view.
//
// Downloaded books are stored in the flat history (src/history.js). Newer
// downloads stamp a `cover` URL captured from the search result, but legacy
// entries (and standard/external ones) have none. This module fills that gap by
// looking a cover up by { title, author } against keyless public catalogs and
// caching the answer to disk so the lookup runs at most once per book.
//
// Design notes:
//   - The catalog parsing (`coverFromOpenLibrary` / `coverFromGoogleBooks`) is
//     PURE so it's unit-testable without the network.
//   - The network call (`lookupCover`) takes an injectable `fetchImpl`/`timeoutMs`
//     so tests run offline.
//   - The cache (`resolveCover`) takes an injectable `lookup` + `cache` so the
//     resolve-or-fetch-then-store flow is testable without touching the network
//     or the filesystem.
//   - FAIL SOFT: any lookup error/timeout resolves to `null` (no cover). A cover
//     is decoration; it must never block or break the Library.
//   - NEGATIVES ARE CACHED so a book with genuinely no cover isn't re-queried on
//     every Library open. Negatives carry a timestamp and expire (see
//     NEGATIVE_TTL_MS) so a later-added cover can still be discovered.

const fs = require('fs');
const path = require('path');
const { normalize, similarity, matchScore } = require('./correct');

const OPEN_LIBRARY_URL = 'https://openlibrary.org/search.json';
const GOOGLE_BOOKS_URL = 'https://www.googleapis.com/books/v1/volumes';
const LOOKUP_TIMEOUT_MS = 4000;
const CACHE_FILE = path.join(__dirname, '..', 'covers-cache.json');

// A candidate's title must match the query title at least this well (the same
// variant-aware scorer the spell-corrector uses) before we'll trust its cover.
// Gating on this is what stops "Whistler" grabbing Grisham's "The Whistler".
const TITLE_THRESHOLD = 0.7;
// When we know the author, the candidate's author must corroborate it. This is
// the decisive guard for same-title-different-book collisions.
const AUTHOR_THRESHOLD = 0.6;

// Re-attempt a "no cover found" result after a week — books get covers added to
// the catalogs over time, so a negative shouldn't be permanent.
const NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// `normalize` (lowercase, fold punctuation, collapse runs) is shared with the
// spell-corrector — imported above so the cache key and the match scorer agree.

/** Cache key for a book. */
function cacheKey({ title, author }) {
  return normalize(title) + '|' + normalize(author);
}

/** Strip the noise a forum title carries that a catalog title never will — a
 *  trailing "by Author…" (we look the author up separately) and a trailing
 *  format/edition/year parenthetical ("(.ePUB)", "(2024 Edition)"). Improves the
 *  match rate for messy stored titles; author gating still guards correctness.
 *  Returns the original when cleaning would empty it. PURE. (A trimmed cousin of
 *  downloader.cleanBookTitle, inlined to keep this module free of the browser
 *  stack that downloader pulls in.) */
function cleanTitle(t) {
  const orig = String(t || '').trim();
  let s = orig;
  s = s.replace(/\s+by\s+.+$/i, '');
  s = s.replace(
    /\s*[([][^)\]]*\b(?:retail|epub|pdf|mobi|azw3?|edition|version|19\d{2}|20\d{2})\b[^)\]]*[)\]]\s*$/i,
    ''
  );
  s = s.replace(/\s+/g, ' ').trim();
  return s || orig;
}

/** Build the Open Library cover image URL from a cover id. `size` ∈ S|M|L. */
function openLibraryCoverUrl(coverId, size = 'M') {
  return `https://covers.openlibrary.org/b/id/${coverId}-${size}.jpg`;
}

/** Does any of a candidate's authors corroborate the query author? With no query
 *  author we can't gate on it (return true); otherwise require a close match OR
 *  full token containment either way ("Patchett" ⊂ "Ann Patchett"). PURE. */
function authorMatches(queryAuthor, candidateAuthors) {
  const q = normalize(queryAuthor);
  if (!q) return true; // nothing to check against — don't reject on author
  const qTokens = q.split(' ').filter(Boolean);
  for (const a of [].concat(candidateAuthors || [])) {
    const na = normalize(a);
    if (!na) continue;
    if (similarity(q, na) >= AUTHOR_THRESHOLD) return true;
    const aTokens = na.split(' ').filter(Boolean);
    if (qTokens.every((t) => aTokens.includes(t))) return true; // query ⊆ candidate
    if (aTokens.every((t) => qTokens.includes(t))) return true; // candidate ⊆ query
  }
  return false;
}

// PURE: from a list of catalog records, pick the cover of the record that best
// matches { title, author } and clears both gates — or null if none does. Better
// to show no cover than the wrong book's cover.
function pickMatchingCover(query, records, getTitle, getAuthors, getCover) {
  let bestCover = null;
  let bestScore = -1;
  for (const rec of records) {
    const cover = getCover(rec);
    if (!cover) continue;
    const tScore = query.title ? matchScore(query.title, getTitle(rec) || '') : 1;
    if (tScore < TITLE_THRESHOLD) continue;
    if (!authorMatches(query.author, getAuthors(rec))) continue;
    if (tScore > bestScore) {
      bestScore = tScore;
      bestCover = cover;
    }
  }
  return bestCover;
}

/** PURE: best title+author-matching cover from an Open Library payload, or null. */
function coverFromOpenLibrary(query, data) {
  const docs = (data && Array.isArray(data.docs)) ? data.docs : [];
  return pickMatchingCover(
    query || {},
    docs,
    (d) => d.title,
    (d) => d.author_name,
    (d) => (d && Number.isFinite(d.cover_i) ? openLibraryCoverUrl(d.cover_i) : null)
  );
}

/** PURE: best title+author-matching cover thumbnail from a Google Books payload,
 *  or null. Google serves thumbnails over http; upgrade to https so the CSP
 *  (img-src https:) and a secure origin don't block them. */
function coverFromGoogleBooks(query, data) {
  const items = (data && Array.isArray(data.items)) ? data.items : [];
  return pickMatchingCover(
    query || {},
    items,
    (i) => i.volumeInfo && i.volumeInfo.title,
    (i) => i.volumeInfo && i.volumeInfo.authors,
    (i) => {
      const links = i.volumeInfo && i.volumeInfo.imageLinks;
      const url = links && (links.thumbnail || links.smallThumbnail);
      return url ? String(url).replace(/^http:/, 'https:') : null;
    }
  );
}

/** GET + parse JSON with an abort timeout. Throws on any failure. */
async function fetchJson(url, { fetchImpl = fetch, timeoutMs = LOOKUP_TIMEOUT_MS } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { signal: ac.signal, headers: { 'User-Agent': 'mobilism-finder/1.0' } });
  } finally {
    clearTimeout(timer);
  }
  if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
  return res.json();
}

/**
 * Look a cover up by { title, author }. Open Library first (keyless, no quota),
 * Google Books as a fallback. Returns a cover URL string, or null when nothing
 * confident is found / every source fails. NEVER throws.
 *
 * `opts.fetchImpl`/`opts.timeoutMs`/`opts.apiKey` are injectable for tests.
 */
async function lookupCover({ title, author }, opts = {}) {
  const t = cleanTitle(title);
  const a = String(author || '').trim();
  if (!t && !a) return null;

  const query = { title: t, author: a };

  // 1. Open Library: fielded title/author query; ask for the fields we verify on.
  try {
    const params = new URLSearchParams({ limit: '5', fields: 'title,author_name,cover_i' });
    if (t) params.set('title', t);
    if (a) params.set('author', a);
    const data = await fetchJson(`${OPEN_LIBRARY_URL}?${params.toString()}`, opts);
    const cover = coverFromOpenLibrary(query, data);
    if (cover) return cover;
  } catch {
    // fall through to Google Books
  }

  // 2. Google Books: plain combined query; pick the best title+author match.
  try {
    const terms = [t, a].filter(Boolean).join(' ').trim();
    const key = opts.apiKey || process.env.GOOGLE_BOOKS_API_KEY;
    const url = `${GOOGLE_BOOKS_URL}?q=${encodeURIComponent(terms)}&maxResults=5&country=US${key ? '&key=' + encodeURIComponent(key) : ''}`;
    const data = await fetchJson(url, opts);
    const cover = coverFromGoogleBooks(query, data);
    if (cover) return cover;
  } catch {
    // fall through to null
  }

  return null;
}

// --- Persistent cache -------------------------------------------------------

function readCacheFile() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);
    return (data && typeof data === 'object') ? data : {};
  } catch {
    return {};
  }
}

function writeCacheFile(data) {
  const json = JSON.stringify(data, null, 2);
  const tmp = CACHE_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, CACHE_FILE);
  } catch {
    // Atomic rename can fail on bind-mounted volumes (Docker/WSL2) — fall back.
    fs.writeFileSync(CACHE_FILE, json, 'utf8');
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// Default cache backed by the on-disk JSON file. Records are
// `{ cover: string|null, ts: epochMs }`.
const fileCache = {
  get(key) {
    return readCacheFile()[key] || null;
  },
  set(key, record) {
    const data = readCacheFile();
    data[key] = record;
    writeCacheFile(data);
  },
};

/** Is a cached negative still fresh enough to trust (skip re-lookup)? */
function negativeIsFresh(record, now) {
  return record && !record.cover && (now - (record.ts || 0)) < NEGATIVE_TTL_MS;
}

/**
 * Resolve a cover for { title, author }, consulting the cache before the
 * network and writing the result back. Returns a cover URL or null. NEVER
 * throws.
 *
 * `opts.lookup` overrides the network lookup (tests); `opts.cache` overrides the
 * persistence layer (tests). Remaining opts pass through to `lookupCover`.
 */
async function resolveCover({ title, author }, opts = {}) {
  const t = String(title || '').trim();
  const a = String(author || '').trim();
  if (!t && !a) return null;

  const cache = opts.cache || fileCache;
  const lookup = opts.lookup || lookupCover;
  const key = cacheKey({ title: t, author: a });
  const now = opts.now || Date.now();

  const cached = cache.get(key);
  if (cached) {
    if (cached.cover) return cached.cover; // positive hit — always trust
    if (negativeIsFresh(cached, now)) return null; // fresh negative — don't re-query
    // stale negative falls through to a fresh lookup
  }

  let cover = null;
  try {
    cover = await lookup({ title: t, author: a }, opts);
  } catch {
    cover = null;
  }
  try {
    cache.set(key, { cover: cover || null, ts: now });
  } catch {
    // a cache write failure must not break the resolve
  }
  return cover || null;
}

module.exports = {
  lookupCover,
  resolveCover,
  coverFromOpenLibrary,
  coverFromGoogleBooks,
  authorMatches,
  cleanTitle,
  openLibraryCoverUrl,
  cacheKey,
  CACHE_FILE,
};
