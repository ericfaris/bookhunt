'use strict';

// Pure helpers for the client-side result filter/sort bar. Search results are
// fetched once and then filtered/sorted in the browser (no re-scrape); this
// module is the canonical, unit-tested spec for that behaviour. app.js mirrors
// these functions for use in the browser (same convention as splitTitleAuthor).

const UNIT_BYTES = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

/** PURE: parse a human size like "2.4 MB" / "900 KB" to bytes, or null. */
function parseSizeToBytes(size) {
  if (typeof size !== 'string') return null;
  const m = size.trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)$/i);
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * UNIT_BYTES[m[2].toUpperCase()]);
}

/** PURE: is this result an ePUB? (lenient — anything not explicitly "other"). */
function isEpub(r) {
  return String(r && r.format || '').toLowerCase() === 'epub';
}

/**
 * PURE: filter results by format and size. Unknown sizes are kept (never hidden
 * by a size bound). `opts`:
 *   format: 'all' | 'epub' | 'other'   (default 'all')
 *   minMB, maxMB: numbers (optional)
 */
function filterResults(results, opts = {}) {
  const { format = 'all', minMB, maxMB } = opts;
  const min = Number.isFinite(minMB) ? minMB * UNIT_BYTES.MB : null;
  const max = Number.isFinite(maxMB) ? maxMB * UNIT_BYTES.MB : null;
  return (results || []).filter((r) => {
    if (format === 'epub' && !isEpub(r)) return false;
    if (format === 'other' && isEpub(r)) return false;
    const bytes = parseSizeToBytes(r && r.size);
    if (bytes != null) {
      if (min != null && bytes < min) return false;
      if (max != null && bytes > max) return false;
    }
    return true;
  });
}

function dateMs(r) {
  const t = r && r.date ? Date.parse(r.date) : NaN;
  return Number.isNaN(t) ? null : t;
}

/**
 * PURE: return a sorted COPY of results. `sort`:
 *   'relevance' (default) keeps the server's order (best match first)
 *   'newest' | 'oldest'   by date (unknown dates sink to the end)
 *   'largest' | 'smallest' by size (unknown sizes sink to the end)
 */
function sortResults(results, sort = 'relevance') {
  const arr = (results || []).map((r, i) => ({ r, i }));
  const nullsLast = (a, b, get, dir) => {
    const av = get(a.r);
    const bv = get(b.r);
    if (av == null && bv == null) return a.i - b.i;
    if (av == null) return 1;
    if (bv == null) return -1;
    return av === bv ? a.i - b.i : dir * (av - bv);
  };
  switch (sort) {
    case 'newest': arr.sort((a, b) => nullsLast(a, b, dateMs, -1)); break;
    case 'oldest': arr.sort((a, b) => nullsLast(a, b, dateMs, 1)); break;
    case 'largest': arr.sort((a, b) => nullsLast(a, b, (r) => parseSizeToBytes(r.size), -1)); break;
    case 'smallest': arr.sort((a, b) => nullsLast(a, b, (r) => parseSizeToBytes(r.size), 1)); break;
    case 'relevance':
    default: break; // preserve original order
  }
  return arr.map((x) => x.r);
}

module.exports = { parseSizeToBytes, isEpub, filterResults, sortResults };
