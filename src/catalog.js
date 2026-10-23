'use strict';

// Shared HTTP plumbing for the public book catalogs (Open Library, Google
// Books, Apple Books) used by spell-correction (correct.js) and cover/blurb
// lookup (covers.js). The two deliberately send DIFFERENT queries (see each
// module); only the transport and endpoints are shared.

const OPEN_LIBRARY_URL = 'https://openlibrary.org/search.json';
const GOOGLE_BOOKS_URL = 'https://www.googleapis.com/books/v1/volumes';
// Apple Books (iTunes Search API): keyless, and the strongest source for recent
// ebooks. Rate-limited to roughly 20 requests/minute per IP.
const ITUNES_URL = 'https://itunes.apple.com/search';
const LOOKUP_TIMEOUT_MS = 4000;
// Backoff between retries of a TRANSIENT failure (429, 5xx, timeout, network
// error). A 4xx other than 429 is a real answer and is never retried.
const RETRY_DELAYS_MS = [500, 1500];
const MAX_RETRY_AFTER_MS = 4000;
const USER_AGENT = 'bookhunt/1.0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET + parse JSON with an abort timeout. TRANSIENT failures (network error,
 * timeout, 429, 5xx) are retried with backoff (`retryDelays`; pass [] to fail
 * fast; a Retry-After header is honored up to MAX_RETRY_AFTER_MS). Throws once
 * out of tries; the error carries `.transient` so callers can tell "this source
 * is down / rate limiting us" from "this source answered".
 */
async function fetchJson(url, { fetchImpl = fetch, timeoutMs = LOOKUP_TIMEOUT_MS, retryDelays = RETRY_DELAYS_MS, sleepImpl = sleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res = null;
    let err = null;
    try {
      res = await fetchImpl(url, { signal: ac.signal, headers: { 'User-Agent': USER_AGENT } });
    } catch (e) {
      err = e;
    } finally {
      clearTimeout(timer);
    }
    if (res && res.ok) return res.json();
    const transient = !res || res.status === 429 || res.status >= 500;
    if (transient && attempt < retryDelays.length) {
      let wait = retryDelays[attempt];
      const ra = res && res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('retry-after')) : NaN;
      if (Number.isFinite(ra) && ra > 0) wait = Math.min(ra * 1000, MAX_RETRY_AFTER_MS);
      await sleepImpl(wait);
      continue;
    }
    const e = err || new Error('HTTP ' + (res && res.status));
    e.transient = transient;
    throw e;
  }
}

/** Google Books volumes URL. Reads GOOGLE_BOOKS_API_KEY (avoids the shared
 *  anonymous daily-quota 429s); country is required for unauthenticated calls. */
function googleBooksUrl(q, { maxResults = 10, apiKey } = {}) {
  const key = apiKey || process.env.GOOGLE_BOOKS_API_KEY;
  return `${GOOGLE_BOOKS_URL}?q=${encodeURIComponent(q)}&maxResults=${maxResults}&country=US${key ? '&key=' + encodeURIComponent(key) : ''}`;
}

module.exports = {
  OPEN_LIBRARY_URL,
  GOOGLE_BOOKS_URL,
  ITUNES_URL,
  LOOKUP_TIMEOUT_MS,
  RETRY_DELAYS_MS,
  MAX_RETRY_AFTER_MS,
  USER_AGENT,
  fetchJson,
  googleBooksUrl,
};
