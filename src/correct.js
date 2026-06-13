'use strict';

// Fuzzy spell-correction of a { title, author } request BEFORE it hits the
// Mobilism scrape. Misspelled requests ("Hary Poter", "J.K. Rowlng") produce
// bad or empty results, so we look the request up against an external book
// repository and, when a strong match comes back, swap in the canonical
// spelling.
//
// Source: Google Books first (strongest typo tolerance), then Open Library as a
// keyless fallback. Anonymous Google Books calls share a daily project quota and
// 429 readily, so set GOOGLE_BOOKS_API_KEY for reliable correction; without it
// we still get Open Library for free. Both are queried TITLE-FIRST: a misspelled
// author tacked onto the query tends to zero out the match, whereas the canonical
// author falls out of the title match for free.
//
// Design notes:
//   - The decision logic (`reconcile`) is PURE and dependency-free so it's
//     unit-testable: it gates each field on a confidence threshold and never
//     touches the network.
//   - The network lookups are isolated (and injectable via opts) so tests run
//     offline and the real calls can be swapped/mocked.
//   - FAIL OPEN: any lookup error/timeout returns the original terms unchanged.
//     A search must never be blocked on the corrector.
//   - NO NOISE: when the input already matches (ignoring case/punctuation) or no
//     confident match exists, `corrected` is false and the original passes
//     through untouched.

const GOOGLE_BOOKS_URL = 'https://www.googleapis.com/books/v1/volumes';
const OPEN_LIBRARY_URL = 'https://openlibrary.org/search.json';
const LOOKUP_TIMEOUT_MS = 4000;

// Levenshtein-ratio threshold for accepting a field correction. 0.7 keeps
// typo-level edits ("hary poter" → "harry potter", ratio ≈ 0.83) while rejecting
// genuinely different titles (a wrong-book match scores far lower).
const ACCEPT_THRESHOLD = 0.7;

/** Lowercase, fold punctuation to spaces, collapse runs, trim — so comparisons
 *  ignore case/punctuation differences ("J.K. Rowling" ≈ "j k rowling"). */
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Collapse internal whitespace without otherwise altering the string. */
function cleanWhitespace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** Classic Levenshtein edit distance between two strings. */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

/** Similarity in [0,1]: 1 − distance / longer-length. 1 = identical. */
function similarity(a, b) {
  if (!a && !b) return 1;
  const max = Math.max(a.length, b.length);
  if (!max) return 1;
  return 1 - levenshtein(a, b) / max;
}

/**
 * How well a candidate title corresponds to the typed term, in [0,1]. Same
 * notion `correctedField` gates on: best of the full-string similarity and the
 * candidate's leading-token prefix (so "Harry Potter and the…" still scores high
 * for "Hary Poter"). Used to pick the best of several search hits — providers
 * often return an author-prefixed or study-guide edition first.
 */
function matchScore(orig, cand) {
  const no = normalize(orig);
  const nc = normalize(cand);
  if (!no || !nc) return 0;
  if (no === nc) return 1;
  let best = similarity(no, nc);
  const ot = no.split(' ').length;
  const cw = nc.split(' ');
  if (cw.length > ot) best = Math.max(best, similarity(no, cw.slice(0, ot).join(' ')));
  return best;
}

/** Pick the element whose `getTitle(el)` best matches `origTitle`; the first
 *  element when there's no title to score against. Pure. */
function pickBest(origTitle, list, getTitle) {
  if (!Array.isArray(list) || !list.length) return null;
  if (!origTitle) return list[0];
  return list.reduce((best, el) =>
    matchScore(origTitle, getTitle(el)) > matchScore(origTitle, getTitle(best)) ? el : best
  );
}

/**
 * Decide the corrected value for a single field. Pure.
 *   - Empty original → left empty (we correct typos, we don't invent fields).
 *   - Identical ignoring case/punctuation → original kept verbatim (no noise).
 *   - Strong full-string match → take the candidate's canonical spelling.
 *   - Otherwise compare the candidate's LEADING tokens (Google often returns a
 *     longer canonical title, e.g. "Harry Potter and the …"); if those match the
 *     typed term, return just that prefix so the search stays close to intent.
 *   - Too different → original untouched (likely a wrong-book match).
 */
function correctedField(orig, cand) {
  const o = String(orig || '');
  if (!o) return o; // never fill a field the user left blank
  const candClean = cleanWhitespace(cand);
  if (!candClean) return o;

  const no = normalize(o);
  const nc = normalize(candClean);
  if (!no || no === nc) return o; // already a match (ignoring case/punct)

  if (similarity(no, nc) >= ACCEPT_THRESHOLD) return candClean;

  const origTokenCount = no.split(' ').length;
  const candWords = candClean.split(' ');
  if (candWords.length > origTokenCount) {
    const prefix = candWords.slice(0, origTokenCount).join(' ');
    const np = normalize(prefix);
    if (np === no) return o; // prefix is just a re-cased original — not a correction
    if (similarity(no, np) >= ACCEPT_THRESHOLD) return prefix;
  }
  return o; // not confident — leave the typed term alone
}

/** Shape returned when nothing is corrected. */
function passthrough(original, source = null) {
  return { title: original.title, author: original.author, corrected: false, original, source };
}

/**
 * Apply a candidate { title, author, source? } to the original request. Pure.
 * Returns { title, author, corrected, original:{title,author}, source }.
 */
function reconcile(original, candidate, source) {
  if (!candidate) return passthrough(original, source || null);
  const title = correctedField(original.title, candidate.title);
  const author = correctedField(original.author, candidate.author);
  const corrected = title !== original.title || author !== original.author;
  return { title, author, corrected, original, source: candidate.source || source || null };
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
 * Query Google Books for the best { title, author } candidate. Returns null on
 * no match, throws on transport/quota failure so the caller can fall through.
 * Reads GOOGLE_BOOKS_API_KEY (avoids the shared anonymous daily-quota 429s).
 *
 * Uses a PLAIN combined "title author" query — NOT the intitle:/inauthor:
 * operators. Google's matching is fuzzy enough that the combined query uses both
 * signals to land the real edition, whereas `intitle:<typo>` matches misspelled
 * parody/knockoff books whose own metadata carries the typo. (Open Library is the
 * opposite — see lookupOpenLibrary.)
 */
async function lookupGoogleBooks({ title, author }, opts = {}) {
  const terms = [title, author].filter(Boolean).join(' ').trim();
  if (!terms) return null;
  const key = opts.apiKey || process.env.GOOGLE_BOOKS_API_KEY;
  // country is required by the Books API for unauthenticated calls.
  const url = `${GOOGLE_BOOKS_URL}?q=${encodeURIComponent(terms)}&maxResults=5&country=US${key ? '&key=' + encodeURIComponent(key) : ''}`;
  const data = await fetchJson(url, opts);
  const items = (Array.isArray(data.items) ? data.items : []).filter((i) => i && i.volumeInfo && i.volumeInfo.title);
  const item = pickBest(title, items, (i) => i.volumeInfo.title);
  if (!item) return null;
  const vi = item.volumeInfo;
  return {
    title: cleanWhitespace(vi.title),
    author: cleanWhitespace(Array.isArray(vi.authors) ? vi.authors[0] : ''),
    source: 'google-books',
  };
}

/**
 * Query Open Library (keyless, no per-project quota) for the best candidate.
 * Title-first general query — its fielded title/author search is much less
 * typo-tolerant than the combined `q=` param.
 */
async function lookupOpenLibrary({ title, author }, opts = {}) {
  const q = title || author;
  if (!q) return null;
  const url = `${OPEN_LIBRARY_URL}?q=${encodeURIComponent(q)}&limit=5&fields=title,author_name`;
  const data = await fetchJson(url, opts);
  const docs = (Array.isArray(data.docs) ? data.docs : []).filter((d) => d && d.title);
  const doc = pickBest(title, docs, (d) => d.title);
  if (!doc) return null;
  return {
    title: cleanWhitespace(doc.title),
    author: cleanWhitespace(Array.isArray(doc.author_name) ? doc.author_name[0] : ''),
    source: 'open-library',
  };
}

/**
 * Default lookup: try each source in order, returning the first usable
 * candidate. A source that throws (quota/timeout) is skipped so a later one can
 * still succeed; all-failed yields null (→ caller fails open to the original).
 */
async function defaultLookup(original, opts = {}) {
  for (const src of [lookupGoogleBooks, lookupOpenLibrary]) {
    try {
      const c = await src(original, opts);
      if (c && (c.title || c.author)) return c;
    } catch {
      /* try the next source */
    }
  }
  return null;
}

/**
 * Correct a { title, author } request. Returns the (possibly unchanged) terms
 * plus `corrected` + `original` + `source` so callers can search/log with the
 * clean spelling and surface a before→after notice. Always resolves — never
 * throws.
 *
 * `opts.lookup` overrides the lookup fn (tests); `opts.fetchImpl`/`opts.timeoutMs`/
 * `opts.apiKey` are forwarded to the default source chain.
 */
async function correct(input, opts = {}) {
  const original = {
    title: (input && typeof input.title === 'string' ? input.title : '').trim(),
    author: (input && typeof input.author === 'string' ? input.author : '').trim(),
  };
  if (!original.title && !original.author) return passthrough(original);

  const lookup = opts.lookup || defaultLookup;
  try {
    const candidate = await lookup(original, opts);
    return reconcile(original, candidate, opts.source);
  } catch {
    return passthrough(original); // fail open: search proceeds on the original
  }
}

module.exports = {
  correct,
  reconcile,
  correctedField,
  normalize,
  similarity,
  matchScore,
  pickBest,
  levenshtein,
  lookupGoogleBooks,
  lookupOpenLibrary,
  defaultLookup,
  ACCEPT_THRESHOLD,
};
