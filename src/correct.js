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

// Levenshtein-ratio threshold for accepting a field correction. 0.75 keeps
// typo-level edits ("hary poter" → "harry potter", ratio ≈ 0.83) while rejecting
// genuinely different titles (a wrong-book match scores far lower).
const ACCEPT_THRESHOLD = 0.75;

// When the OTHER field corroborates strongly (e.g. an exact author match), the
// candidate is high-confidence regardless, so a borderline field correction is
// accepted at a looser threshold. This catches near-typos that just miss 0.75
// ("Mad Maple" → "Mad Mabel", ratio ≈ 0.67) when the author confirms the book.
const LOOSE_THRESHOLD = 0.6;

// How strongly the other field must match to grant the loosening above.
const CORROBORATE_THRESHOLD = 0.85;

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
 * Generate plausible "what the user actually meant" forms of a catalogue title.
 * Book APIs decorate titles in ways the typed query never will — subtitles after
 * a colon, edition/language tags in parens ("(Tamil)"), trailing series numbers
 * ("… and Roses 7"), or the full canonical title when the user typed a short form
 * ("Harry Potter and the …"). We compare ALL of these against the typed term and
 * keep whichever is closest, so a junk tail is dropped while a legitimately longer
 * title (a mid-word omission like "It Ends Us" → "It Ends with Us") is preserved.
 */
function candidateVariants(cand, origTokenCount) {
  const base = cleanWhitespace(cand);
  const v = new Set();
  if (!base) return [];
  v.add(base);
  v.add(base.split(/\s*[:–—]\s+/)[0].trim()); // drop subtitle after colon / spaced dash
  v.add(base.replace(/\s*[([][^)\]]*[)\]]\s*$/, '').trim()); // drop trailing (paren)/[bracket]
  v.add(base.replace(/\s+\d{1,4}\s*$/, '').trim()); // drop a trailing series number
  const words = base.split(' '); // leading tokens = typed-length canonical prefix
  if (origTokenCount && words.length > origTokenCount) v.add(words.slice(0, origTokenCount).join(' '));
  return [...v].filter(Boolean);
}

/**
 * Best { score, variant } for a candidate against the typed term: the variant
 * (see candidateVariants) whose normalized form is closest to the original, with
 * its similarity in [0,1]. The single source of truth for both candidate ranking
 * (pickBest) and the per-field correction gate (correctedField).
 */
function bestVariant(orig, cand) {
  const no = normalize(orig);
  if (!no) return { score: 0, variant: cleanWhitespace(cand) };
  let best = '';
  let bestScore = -1;
  for (const variant of candidateVariants(cand, no.split(' ').length)) {
    const score = similarity(no, normalize(variant));
    if (score > bestScore) {
      bestScore = score;
      best = variant;
    }
  }
  return { score: Math.max(bestScore, 0), variant: best };
}

/** How well a candidate corresponds to the typed term, in [0,1]. */
function matchScore(orig, cand) {
  return bestVariant(orig, cand).score;
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
 *   - Pick the closest candidate variant (drops junk tails, keeps real words).
 *   - Identical ignoring case/punctuation → original kept verbatim (no noise).
 *   - Close enough (≥ threshold) → take that variant's spelling.
 *   - Too different → original untouched (likely a wrong-book match).
 */
function correctedField(orig, cand, threshold = ACCEPT_THRESHOLD) {
  const o = String(orig || '');
  if (!o) return o; // never fill a field the user left blank
  const { score, variant } = bestVariant(o, cand);
  if (!variant || normalize(variant) === normalize(o)) return o; // nothing / re-cased only
  return score >= threshold ? variant : o;
}

/** The other field gives independent evidence this is the right book when it
 *  matches strongly. A blank original gives no positive evidence. Pure. */
function corroborates(orig, cand) {
  return !!orig && matchScore(orig, cand) >= CORROBORATE_THRESHOLD;
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
  // A strong match on one field corroborates the other, loosening its gate so a
  // borderline typo (just under ACCEPT_THRESHOLD) is still corrected.
  const titleThreshold = corroborates(original.author, candidate.author) ? LOOSE_THRESHOLD : ACCEPT_THRESHOLD;
  const authorThreshold = corroborates(original.title, candidate.title) ? LOOSE_THRESHOLD : ACCEPT_THRESHOLD;
  const title = correctedField(original.title, candidate.title, titleThreshold);
  const author = correctedField(original.author, candidate.author, authorThreshold);
  const corrected = title !== original.title || author !== original.author;
  return { title, author, corrected, original, source: candidate.source || source || null };
}

/** GET + parse JSON with an abort timeout. Throws on any failure. */
async function fetchJson(url, { fetchImpl = fetch, timeoutMs = LOOKUP_TIMEOUT_MS } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { signal: ac.signal, headers: { 'User-Agent': 'bookhunt/1.0' } });
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

/** Combined evidence that a candidate is the typed book: the mean of the
 *  per-field match scores over the fields the user actually supplied. Pure. */
function combinedScore(original, cand) {
  if (!cand) return 0;
  const scores = [];
  if (original.title) scores.push(matchScore(original.title, cand.title));
  if (original.author) scores.push(matchScore(original.author, cand.author));
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
}

/**
 * Default lookup: query every source in PARALLEL and return the candidate that
 * best matches BOTH typed fields. Querying both (rather than stopping at the
 * first hit) means a source that returns a junk/wrong top result no longer
 * shadows a better answer from the other. A source that throws (quota/timeout)
 * is ignored; all-failed yields null (→ caller fails open to the original).
 */
async function defaultLookup(original, opts = {}) {
  const settled = await Promise.allSettled([
    lookupGoogleBooks(original, opts),
    lookupOpenLibrary(original, opts),
  ]);
  const candidates = settled
    .filter((r) => r.status === 'fulfilled' && r.value && (r.value.title || r.value.author))
    .map((r) => r.value);
  if (!candidates.length) return null;
  return candidates.reduce((best, c) =>
    combinedScore(original, c) > combinedScore(original, best) ? c : best
  );
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
  bestVariant,
  candidateVariants,
  combinedScore,
  pickBest,
  levenshtein,
  lookupGoogleBooks,
  lookupOpenLibrary,
  defaultLookup,
  ACCEPT_THRESHOLD,
};
