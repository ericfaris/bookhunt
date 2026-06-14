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

const OPEN_LIBRARY_URL = 'https://openlibrary.org/search.json';
const GOOGLE_BOOKS_URL = 'https://www.googleapis.com/books/v1/volumes';
const LOOKUP_TIMEOUT_MS = 4000;
const CACHE_FILE = path.join(__dirname, '..', 'covers-cache.json');

// Re-attempt a "no cover found" result after a week — books get covers added to
// the catalogs over time, so a negative shouldn't be permanent.
const NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Lowercase, fold punctuation to spaces, collapse runs, trim — a stable cache
 *  key that ignores case/punctuation differences in title/author. */
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cache key for a book. */
function cacheKey({ title, author }) {
  return normalize(title) + '|' + normalize(author);
}

/** Build the Open Library cover image URL from a cover id. `size` ∈ S|M|L. */
function openLibraryCoverUrl(coverId, size = 'M') {
  return `https://covers.openlibrary.org/b/id/${coverId}-${size}.jpg`;
}

/** PURE: pull a cover URL out of an Open Library search.json payload, or null. */
function coverFromOpenLibrary(data) {
  const docs = (data && Array.isArray(data.docs)) ? data.docs : [];
  for (const doc of docs) {
    if (doc && Number.isFinite(doc.cover_i)) return openLibraryCoverUrl(doc.cover_i);
  }
  return null;
}

/** PURE: pull a cover thumbnail out of a Google Books volumes payload, or null.
 *  Google serves thumbnails over http; upgrade to https so the CSP (img-src
 *  https:) and a secure origin don't block them. */
function coverFromGoogleBooks(data) {
  const items = (data && Array.isArray(data.items)) ? data.items : [];
  for (const item of items) {
    const links = item && item.volumeInfo && item.volumeInfo.imageLinks;
    const url = links && (links.thumbnail || links.smallThumbnail);
    if (url) return String(url).replace(/^http:/, 'https:');
  }
  return null;
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
  const t = String(title || '').trim();
  const a = String(author || '').trim();
  if (!t && !a) return null;

  // 1. Open Library: fielded title/author query, ask only for cover_i.
  try {
    const params = new URLSearchParams({ limit: '3', fields: 'cover_i' });
    if (t) params.set('title', t);
    if (a) params.set('author', a);
    const data = await fetchJson(`${OPEN_LIBRARY_URL}?${params.toString()}`, opts);
    const cover = coverFromOpenLibrary(data);
    if (cover) return cover;
  } catch {
    // fall through to Google Books
  }

  // 2. Google Books: plain combined query; grab the first thumbnail.
  try {
    const terms = [t, a].filter(Boolean).join(' ').trim();
    const key = opts.apiKey || process.env.GOOGLE_BOOKS_API_KEY;
    const url = `${GOOGLE_BOOKS_URL}?q=${encodeURIComponent(terms)}&maxResults=3&country=US${key ? '&key=' + encodeURIComponent(key) : ''}`;
    const data = await fetchJson(url, opts);
    const cover = coverFromGoogleBooks(data);
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
  openLibraryCoverUrl,
  cacheKey,
  CACHE_FILE,
};
