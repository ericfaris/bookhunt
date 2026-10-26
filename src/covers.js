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

const path = require('path');
const { normalize, similarity, matchScore } = require('./correct');
const datastore = require('./datastore');
const { stripTitleNoise } = require('./titles');

const { OPEN_LIBRARY_URL, ITUNES_URL, USER_AGENT, fetchJson, googleBooksUrl } = require('./catalog');
const CACHE_FILE = process.env.COVERS_CACHE_FILE || path.join(__dirname, '..', 'covers-cache.json');

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
// A miss where some source FAILED (rate limit, timeout) isn't a real answer —
// retry it soon instead of trusting it for a week.
const TRANSIENT_TTL_MS = 60 * 60 * 1000;
// Bumped when the lookup chain gains sources: negatives cached by an older
// chain are re-tried once with the new one (positives stay valid).
const CACHE_VERSION = 2;

// `normalize` (lowercase, fold punctuation, collapse runs) is shared with the
// spell-corrector — imported above so the cache key and the match scorer agree.

/** Cache key for a book. */
function cacheKey({ title, author }) {
  return normalize(title) + '|' + normalize(author);
}

/** Strip the noise a forum title carries that a catalog title never will
 *  (titles.stripTitleNoise: "by Author…", format/edition/year tails). Improves
 *  the match rate for messy stored titles; author gating still guards
 *  correctness. Returns the original when cleaning would empty it. PURE. */
function cleanTitle(t) {
  const orig = String(t || '').trim();
  return stripTitleNoise(orig) || orig;
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

/** PURE: Apple artwork URLs carry their size in the path (…/100x100bb.jpg);
 *  ask for a 600px rendition instead of the 100px thumbnail. */
function itunesLargeArtwork(url) {
  return String(url || '').replace(/\/\d+x\d+(bb)?\.(jpg|png|webp)$/i, '/600x600bb.$2') || null;
}

/** PURE: best title+author-matching cover from an iTunes Search payload, or null. */
function coverFromITunes(query, data) {
  const results = (data && Array.isArray(data.results)) ? data.results : [];
  return pickMatchingCover(
    query || {},
    results,
    (r) => r.trackName,
    (r) => r.artistName,
    (r) => (r && r.artworkUrl100 ? itunesLargeArtwork(String(r.artworkUrl100).replace(/^http:/, 'https:')) : null)
  );
}

/** PURE: blurb of the best title+author-matching iTunes ebook, or null. */
function descriptionFromITunes(query, data) {
  const q = query || {};
  const results = (data && Array.isArray(data.results)) ? data.results : [];
  let best = null;
  let bestScore = -1;
  for (const r of results) {
    if (!r || !r.description) continue;
    const tScore = q.title ? matchScore(q.title, r.trackName || '') : 1;
    if (tScore < TITLE_THRESHOLD) continue;
    if (!authorMatches(q.author, r.artistName)) continue;
    if (tScore > bestScore) { bestScore = tScore; best = r.description; }
  }
  return best ? cleanDescription(best) : null;
}

/** PURE: a Google Books cover URL asking for an 800×1200 rendition. The API
 *  hands out 128px `zoom=1` thumbnails, some with `edge=curl` (a fake page
 *  curl drawn on the corner); `fife=w800-h1200` returns a proper large image. */
function googleLargeCover(url) {
  try {
    const u = new URL(url);
    u.protocol = 'https:';
    u.searchParams.delete('zoom');
    u.searchParams.delete('edge');
    u.searchParams.set('fife', 'w800-h1200');
    return u.toString();
  } catch {
    return url;
  }
}

/** PURE: best-effort upgrade of a thumbnail-sized cover URL to a larger
 *  rendition. Only rewrites hosts whose size convention we know (Open Library
 *  `-S/-M` → `-L`; Amazon `._SX300_` tokens stripped → original upload; Apple
 *  `100x100bb` → `600x600bb`); anything else is returned unchanged. */
function largeCoverUrl(url) {
  const u = String(url || '');
  if (!u) return null;
  if (/^https?:\/\/covers\.openlibrary\.org\//.test(u)) return u.replace(/-[SM](\.jpg)$/i, '-L$1');
  if (/^https?:\/\/[^/]*(media-amazon|images-amazon|ssl-images-amazon)\.com\//.test(u)) {
    return u.replace(/\._[^/]*?_(\.[a-z]+)$/i, '$1');
  }
  if (/^https?:\/\/[^/]*mzstatic\.com\//.test(u)) return itunesLargeArtwork(u);
  if (/^https?:\/\/books\.google(usercontent)?\.com\/books\/(content|publisher)/.test(u)) return googleLargeCover(u);
  return u;
}

// Longest blurb we'll put in an email — Google descriptions can run long, so
// trim to a clean sentence/word boundary and add an ellipsis.
const MAX_BLURB = 600;

/** PURE: strip HTML tags/entities Google sometimes returns, collapse whitespace,
 *  and truncate to MAX_BLURB at a word boundary. Returns '' for empty input. */
function cleanDescription(text) {
  let s = String(text || '')
    .replace(/<[^>]+>/g, ' ')                 // drop any HTML tags
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')        // drop entities
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= MAX_BLURB) return s;
  s = s.slice(0, MAX_BLURB);
  const cut = s.lastIndexOf(' ');
  if (cut > MAX_BLURB * 0.6) s = s.slice(0, cut);
  return s.replace(/[\s.,;:!?-]+$/, '') + '…';
}

/** PURE: description of the best title+author-matching Google Books volume, or
 *  null. Same match gates as the cover picker so we never grab the wrong book's
 *  blurb. */
function descriptionFromGoogleBooks(query, data) {
  const q = query || {};
  const items = (data && Array.isArray(data.items)) ? data.items : [];
  let best = null;
  let bestScore = -1;
  for (const i of items) {
    const vi = (i && i.volumeInfo) || {};
    if (!vi.description) continue;
    const tScore = q.title ? matchScore(q.title, vi.title || '') : 1;
    if (tScore < TITLE_THRESHOLD) continue;
    if (!authorMatches(q.author, vi.authors)) continue;
    if (tScore > bestScore) { bestScore = tScore; best = vi.description; }
  }
  return best ? cleanDescription(best) : null;
}

const IMAGE_FETCH_TIMEOUT_MS = 5000;

/**
 * Download a cover image's bytes so callers (email attachments) never hand a
 * live URL to something else's HTTP client. FAIL SOFT: any non-2xx response,
 * network error, or timeout resolves to `null` — a cover is decoration, never
 * something that should be able to sink an email send. NEVER throws.
 */
async function fetchCoverImage(url, { fetchImpl = fetch, timeoutMs = IMAGE_FETCH_TIMEOUT_MS } = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ac.signal, headers: { 'User-Agent': USER_AGENT } });
    if (!res || !res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length ? buf : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- Source chain -----------------------------------------------------------
// Each source turns { title, author } into { cover, description } (either may
// be null), throwing on failure. They run in order until we have what the
// caller wants; every one is gated by the same title+author match rules, so a
// later, looser source can never hand back the wrong book.

function googleUrl(q, opts) {
  return googleBooksUrl(q, { maxResults: 10, apiKey: opts.apiKey });
}

const SOURCES = [
  {
    // Fielded title/author query — precise, keyless, no quota.
    name: 'openlibrary',
    async run(query, opts) {
      const params = new URLSearchParams({ limit: '10', fields: 'title,author_name,cover_i' });
      if (query.title) params.set('title', query.title);
      if (query.author) params.set('author', query.author);
      const data = await fetchJson(`${OPEN_LIBRARY_URL}?${params.toString()}`, opts);
      return { cover: coverFromOpenLibrary(query, data), description: null };
    },
  },
  {
    name: 'itunes',
    async run(query, opts) {
      const term = [query.title, query.author].filter(Boolean).join(' ');
      const params = new URLSearchParams({ term, media: 'ebook', entity: 'ebook', limit: '10', country: 'US' });
      const data = await fetchJson(`${ITUNES_URL}?${params.toString()}`, opts);
      return { cover: coverFromITunes(query, data), description: descriptionFromITunes(query, data) };
    },
  },
  {
    name: 'google',
    async run(query, opts) {
      const data = await fetchJson(googleUrl([query.title, query.author].filter(Boolean).join(' '), opts), opts);
      return { cover: coverFromGoogleBooks(query, data), description: descriptionFromGoogleBooks(query, data) };
    },
  },
  {
    // Fielded Google query — finds volumes the loose query ranks below 10.
    name: 'google-fielded',
    skip: (query) => !query.title || !query.author,
    async run(query, opts) {
      const data = await fetchJson(googleUrl(`intitle:${query.title} inauthor:${query.author}`, opts), opts);
      return { cover: coverFromGoogleBooks(query, data), description: descriptionFromGoogleBooks(query, data) };
    },
  },
  {
    // Open Library free-text search — catches records whose title/author
    // fields don't match a fielded query (subtitles, "Last, First" authors).
    name: 'openlibrary-general',
    async run(query, opts) {
      const params = new URLSearchParams({ q: [query.title, query.author].filter(Boolean).join(' '), limit: '10', fields: 'title,author_name,cover_i' });
      const data = await fetchJson(`${OPEN_LIBRARY_URL}?${params.toString()}`, opts);
      return { cover: coverFromOpenLibrary(query, data), description: null };
    },
  },
];

/**
 * Run the source chain for { title, author }. Stops as soon as it has a cover
 * (and, with `wantDescription`, a description too). Returns
 * `{ cover, description, transient }` — `transient` is true when nothing was
 * found but at least one source FAILED (rather than answered), so the miss
 * shouldn't be trusted for long. NEVER throws.
 */
async function lookupDetailed({ title, author }, opts = {}, { wantDescription = false } = {}) {
  const t = cleanTitle(title);
  const a = String(author || '').trim();
  const out = { cover: null, description: null, transient: false };
  if (!t && !a) return out;
  const query = { title: t, author: a };
  let failed = false;
  for (const src of opts.sources || SOURCES) {
    if (src.skip && src.skip(query)) continue;
    try {
      const r = (await src.run(query, opts)) || {};
      if (!out.cover && r.cover && !(opts.skipUrls && opts.skipUrls.has(r.cover))) out.cover = r.cover;
      if (!out.description && r.description) out.description = r.description;
    } catch (err) {
      if (!err || err.transient !== false) failed = true;
    }
    if (out.cover && (!wantDescription || out.description)) break;
  }
  out.transient = failed && (!out.cover || (wantDescription && !out.description));
  return out;
}

/**
 * Look a cover up by { title, author } through the whole source chain.
 * Returns a cover URL string, or null when nothing confident is found / every
 * source fails. NEVER throws.
 *
 * `opts.fetchImpl`/`opts.timeoutMs`/`opts.apiKey`/`opts.retryDelays` are
 * injectable for tests.
 */
async function lookupCover(q, opts = {}) {
  return (await lookupDetailed(q, opts)).cover;
}

/**
 * Overwrite the cached cover URL for { title, author } — used when the cached
 * one turned out to be a placeholder/dead image and a later source found a
 * real one. NEVER throws.
 */
function rememberCover({ title, author }, url, opts = {}) {
  try {
    (opts.cache || fileCache).set(
      cacheKey({ title: String(title || '').trim(), author: String(author || '').trim() }),
      { cover: url, ts: opts.now || Date.now(), v: CACHE_VERSION });
  } catch { /* best effort */ }
}

/**
 * Look up BOTH a cover and a blurb for { title, author } through the source
 * chain (Apple Books and Google Books supply blurbs). Returns
 * `{ cover, description, transient }` (cover/description may be null). NEVER
 * throws. Used to enrich a Send and the reader's book-details modal.
 */
async function lookupMeta(q, opts = {}) {
  return lookupDetailed(q, opts, { wantDescription: true });
}

// --- Persistent cache -------------------------------------------------------

// A re-derivable lookup cache: hardened file I/O from the datastore, but never
// mirrored to Atlas.
const cacheStore = datastore.defineStore('covers-cache', { file: CACHE_FILE, shape: 'object', mirror: false });

// The cache lives in memory once loaded: the file was being read + parsed
// (~300 KB) on every get and rewritten on every set. This process is its only
// writer (not mirrored, nothing else touches it), so writes are coalesced and
// flushed shortly after, and on exit.
const WRITE_DEBOUNCE_MS = 2000;
let _mem = null;
let _writeTimer = null;

function memCache() {
  if (!_mem) _mem = cacheStore.read();
  return _mem;
}

function flushCache() {
  if (_writeTimer) { clearTimeout(_writeTimer); _writeTimer = null; }
  if (_mem && _dirty) {
    _dirty = false;
    try { cacheStore.write(_mem); } catch (err) { console.warn('[covers] cache write failed:', err.message); }
  }
}
let _dirty = false;
process.once('exit', flushCache);

const fileCache = {
  get(key) {
    return memCache()[key] || null;
  },
  set(key, record) {
    memCache()[key] = record;
    _dirty = true;
    if (!_writeTimer) {
      _writeTimer = setTimeout(flushCache, WRITE_DEBOUNCE_MS);
      if (_writeTimer.unref) _writeTimer.unref();
    }
  },
};

/** Tests only: drop the in-memory copy so the next read comes from disk. */
function _resetCache() {
  flushCache();
  _mem = null;
}

// Concurrent resolves of the same book (a Library page asks for many covers
// at once) share one network lookup. Only for the default cache + lookup, so
// injected test doubles never cross-talk.
const _inflight = new Map();
function shared(key, opts, fn) {
  if (opts.cache || opts.lookup) return fn();
  if (_inflight.has(key)) return _inflight.get(key);
  const p = fn().finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}

/** Is a cached negative still fresh enough to trust (skip re-lookup)? A miss
 *  from an older (smaller) source chain is never fresh; a miss caused by a
 *  failing source expires after TRANSIENT_TTL_MS instead of a week. */
function negativeIsFresh(record, now) {
  if (!record || record.cover) return false;
  if (record.v !== CACHE_VERSION) return false;
  const ttl = record.transient ? TRANSIENT_TTL_MS : NEGATIVE_TTL_MS;
  return (now - (record.ts || 0)) < ttl;
}

/** Lookups may return a URL string (simple stubs) or `{ cover, transient }`. */
function asResult(r) {
  if (r && typeof r === 'object') return { cover: r.cover || null, description: r.description || null, transient: !!r.transient };
  return { cover: r || null, description: null, transient: false };
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
  return shared('c|' + cacheKey({ title: t, author: a }), opts, () => resolveCoverUncoalesced(t, a, opts));
}

async function resolveCoverUncoalesced(t, a, opts) {
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

  let result;
  try {
    result = asResult(await lookup({ title: t, author: a }, opts));
  } catch {
    result = { cover: null, transient: true }; // a throwing lookup is a failure, not an answer
  }
  try {
    const rec = { cover: result.cover, ts: now, v: CACHE_VERSION };
    if (!result.cover && result.transient) rec.transient = true;
    cache.set(key, rec);
  } catch {
    // a cache write failure must not break the resolve
  }
  return result.cover;
}

/**
 * Resolve BOTH a cover and a blurb for { title, author }, cache-first. Stored
 * under a separate `meta:` key namespace so it never clobbers the cover-only
 * records `resolveCover` writes. Returns `{ cover, description }` (either may be
 * null). NEVER throws.
 *
 * `opts.lookup` (→ lookupMeta) / `opts.cache` are injectable for tests.
 */
async function resolveMeta({ title, author }, opts = {}) {
  const t = String(title || '').trim();
  const a = String(author || '').trim();
  if (!t && !a) return { cover: null, description: null };
  return shared('m|' + cacheKey({ title: t, author: a }), opts, () => resolveMetaUncoalesced(t, a, opts));
}

async function resolveMetaUncoalesced(t, a, opts) {
  const cache = opts.cache || fileCache;
  const lookup = opts.lookup || lookupMeta;
  const key = 'meta:' + cacheKey({ title: t, author: a });
  const now = opts.now || Date.now();

  const cached = cache.get(key);
  if (cached) {
    // Complete, or partial but recent enough under the current chain → trust it.
    if (cached.cover && cached.description) return { cover: cached.cover, description: cached.description };
    if (cached.v === CACHE_VERSION) {
      const ttl = cached.transient ? TRANSIENT_TTL_MS : NEGATIVE_TTL_MS;
      if ((now - (cached.ts || 0)) < ttl) return { cover: cached.cover || null, description: cached.description || null };
    }
    // stale / older-chain partial record falls through to a fresh lookup
  }

  let meta;
  try {
    meta = asResult(await lookup({ title: t, author: a }, opts));
  } catch {
    meta = { cover: null, description: null, transient: true };
  }
  // Never lose what an earlier lookup found (e.g. a cover) just because this
  // run's source happened to be down.
  const cover = meta.cover || (cached && cached.cover) || null;
  const description = meta.description || (cached && cached.description) || null;
  try {
    const rec = { cover, description, ts: now, v: CACHE_VERSION };
    if (meta.transient && !(cover && description)) rec.transient = true;
    cache.set(key, rec);
  } catch {
    // a cache write failure must not break the resolve
  }
  return { cover, description };
}

module.exports = {
  lookupCover,
  lookupDetailed,
  coverFromITunes,
  descriptionFromITunes,
  itunesLargeArtwork,
  largeCoverUrl,
  googleLargeCover,
  fetchJson,
  negativeIsFresh,
  CACHE_VERSION,
  SOURCES,
  resolveCover,
  lookupCover,
  rememberCover,
  lookupMeta,
  resolveMeta,
  fetchCoverImage,
  coverFromOpenLibrary,
  coverFromGoogleBooks,
  descriptionFromGoogleBooks,
  cleanDescription,
  authorMatches,
  cleanTitle,
  openLibraryCoverUrl,
  cacheKey,
  CACHE_FILE,
  flushCache,
  _resetCache,
};
