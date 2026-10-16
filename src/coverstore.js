'use strict';

// Cover IMAGE store: every book cover the app shows is served from here, so a
// cover is found once, saved to disk, and never fetched from the web again.
//
// Before this, only the cover's URL was cached (covers-cache.json) and every
// browser hot-linked Open Library / Google / Amazon for every render — slow on
// phones, at the mercy of those hosts, and books with no catalog match showed
// a blank 📖 placeholder. Now one endpoint per book walks a chain until it has
// an image, so a book never renders blank:
//
//   1. the cover stored with the download (exact edition, from the search hit)
//   2. the cover embedded in the ePUB itself (exact edition, always right)
//   3. the catalog chain in covers.js (Open Library → Apple Books → Google…)
//   4. a generated cover — title + author typeset on a colored jacket
//
// Real images are kept indefinitely; a GENERATED one is re-attempted after
// GENERATED_TTL_MS so a book that later gains a catalog cover picks it up.
// Files live in COVER_IMAGE_DIR (a bind-mounted directory in Docker). This is a
// re-derivable cache, not the only copy of anything — losing it only costs a
// re-fetch — which is why it's local disk rather than R2. Keyed by the same
// normalized title|author as covers-cache.json, so re-downloads of a book (new
// history ids) share one image.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const covers = require('./covers');
const epub = require('./epub');
const storage = require('./storage');

const DIR = process.env.COVER_IMAGE_DIR || path.join(__dirname, '..', 'cover-images');
// Open Library answers a missing cover id with a 43-byte 1×1 GIF; anything this
// small isn't a real jacket.
const MIN_IMAGE_BYTES = 1000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const GENERATED_TTL_MS = 24 * 60 * 60 * 1000;

const EXT_BY_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
const MIME_BY_EXT = Object.fromEntries(Object.entries(EXT_BY_MIME).map(([m, e]) => [e, m]));

/** Stable file key for a book: hash of the normalized title|author. */
function keyFor({ title, author }) {
  return crypto.createHash('sha256').update(covers.cacheKey({ title: title || '', author: author || '' })).digest('hex').slice(0, 24);
}

/** The stored file for a key, if any: { file, mime, generated, mtimeMs }. */
function findStored(key, dir) {
  for (const ext of Object.values(EXT_BY_MIME)) {
    const file = path.join(dir, `${key}.${ext}`);
    try {
      const st = fs.statSync(file);
      return { file, mime: MIME_BY_EXT[ext], generated: ext === 'svg', mtimeMs: st.mtimeMs };
    } catch { /* not this one */ }
  }
  return null;
}

/** Save `bytes` as the key's only file (any other format for it is removed). */
function writeStored(key, dir, bytes, mime) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${key}.${EXT_BY_MIME[mime]}`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, file);
    for (const ext of Object.values(EXT_BY_MIME)) {
      const other = path.join(dir, `${key}.${ext}`);
      if (other !== file) { try { fs.unlinkSync(other); } catch { /* none */ } }
    }
  } catch (err) {
    // Can't persist (read-only/full disk) — still serve the bytes this time.
    console.warn('[coverstore] could not save cover %s: %s', key, err.message);
  }
}

/** Fetch a remote cover and accept it only if it's a real image. */
async function fetchImage(url, opts) {
  if (!url) return null;
  const bytes = await (opts.fetchImage || covers.fetchCoverImage)(url);
  if (!bytes || bytes.length < MIN_IMAGE_BYTES || bytes.length > MAX_IMAGE_BYTES) return null;
  const mime = epub.sniffImageMime(bytes);
  return mime ? { bytes, mime } : null;
}

/** Try the large rendition of a URL first, then the URL as given. */
async function fetchBest(url, opts) {
  const large = covers.largeCoverUrl(url);
  return (large && large !== url && (await fetchImage(large, opts))) || fetchImage(url, opts);
}

// --- Generated cover --------------------------------------------------------

// Cloth-jacket colors: deep enough for white type, distinct from each other.
const JACKETS = [
  ['#1c2a56', '#2d3f7a'], ['#5b1f2a', '#84303f'], ['#1f3d2f', '#2f5d46'],
  ['#3a2350', '#58377a'], ['#173f4a', '#24606e'], ['#4a3418', '#6e4f25'],
];

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

/** PURE: greedy word-wrap to `width` chars, hard-splitting overlong words. */
function wrapWords(text, width, maxLines) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean)
    .flatMap((w) => (w.length > width ? w.match(new RegExp(`.{1,${width}}`, 'g')) : [w]));
  const lines = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last !== undefined && (last + ' ' + w).length <= width) lines[lines.length - 1] = last + ' ' + w;
    else lines.push(w);
  }
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…';
  }
  return lines;
}

/**
 * PURE: a typeset 400×600 SVG jacket for a book with no findable cover — the
 * title large in a serif, the author below a rule, on a color picked stably
 * from the title so the same book always looks the same.
 */
function generatedCoverSvg({ title, author }) {
  const t = String(title || '').trim() || 'Untitled';
  const a = String(author || '').trim();
  const hash = crypto.createHash('sha256').update(t.toLowerCase()).digest();
  const [c1, c2] = JACKETS[hash[0] % JACKETS.length];
  const width = t.length > 60 ? 16 : t.length > 28 ? 14 : 12;
  const lines = wrapWords(t, width, 6);
  const size = lines.length > 4 ? 34 : lines.length > 2 ? 40 : 46;
  const lh = Math.round(size * 1.18);
  const top = 250 - ((lines.length - 1) * lh) / 2;
  const titleText = lines.map((l, i) =>
    `<text x="200" y="${Math.round(top + i * lh)}" text-anchor="middle" font-size="${size}">${escapeXml(l)}</text>`).join('');
  const authorLines = wrapWords(a.toUpperCase(), 24, 2);
  const authorText = authorLines.map((l, i) =>
    `<text x="200" y="${506 + i * 26}" text-anchor="middle" font-size="18" letter-spacing="2.5">${escapeXml(l)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c2}"/><stop offset="1" stop-color="${c1}"/></linearGradient></defs>
<rect width="400" height="600" fill="url(#g)"/>
<rect x="18" y="18" width="364" height="564" fill="none" stroke="#ffffff" stroke-opacity="0.28" stroke-width="1.5"/>
<rect x="0" y="0" width="14" height="600" fill="#000000" fill-opacity="0.18"/>
<g fill="#ffffff" font-family="Georgia, 'Times New Roman', serif" font-weight="700">${titleText}</g>
<rect x="170" y="${a ? 462 : 470}" width="60" height="3" fill="#f1592a"/>
<g fill="#efe6d6" font-family="'Helvetica Neue', Arial, sans-serif" font-weight="600">${authorText}</g>
</svg>`;
}

// --- Resolve ------------------------------------------------------------------

const inflight = new Map();

/**
 * The image to show for `book` ({ title, author, cover?, savePath?,
 * filePresent? }). Returns { bytes, mime, source, generated } — ALWAYS an
 * image (worst case a generated jacket). NEVER throws.
 *
 * opts (tests): dir, now, fetchImage(url)→Buffer|null, resolveCover(q),
 * readBook(savePath)→Buffer, sources (skip epub with `epub: false`).
 */
async function getCoverImage(book, opts = {}) {
  const dir = opts.dir || DIR;
  const now = opts.now || Date.now();
  const key = keyFor(book || {});
  const stored = findStored(key, dir);
  if (stored && (!stored.generated || now - stored.mtimeMs < GENERATED_TTL_MS)) {
    try {
      return { bytes: fs.readFileSync(stored.file), mime: stored.mime, source: 'stored', generated: stored.generated };
    } catch { /* fall through and rebuild */ }
  }

  const flightKey = dir + '|' + key;
  if (inflight.has(flightKey)) return inflight.get(flightKey);
  const p = (async () => {
    const found = await findRealCover(book || {}, opts);
    if (found) {
      writeStored(key, dir, found.bytes, found.mime);
      return { ...found, generated: false };
    }
    const bytes = Buffer.from(generatedCoverSvg(book || {}), 'utf8');
    writeStored(key, dir, bytes, 'image/svg+xml'); // also restarts the retry clock
    return { bytes, mime: 'image/svg+xml', source: 'generated', generated: true };
  })().finally(() => inflight.delete(flightKey));
  inflight.set(flightKey, p);
  return p;
}

/** Steps 1–3 of the chain; null when none produced a real image. */
async function findRealCover(book, opts) {
  try {
    // 1. The cover stored with the download.
    if (book.cover) {
      const hit = await fetchBest(book.cover, opts);
      if (hit) return { ...hit, source: 'stored-url' };
    }
    // 2. The cover inside the ePUB.
    if (book.savePath && book.filePresent !== false && opts.epub !== false) {
      try {
        const buf = await (opts.readBook || ((p) => storage.get().getBuffer(p)))(book.savePath);
        const hit = epub.extractCoverImage(buf);
        if (hit && hit.bytes.length >= MIN_IMAGE_BYTES) return { ...hit, source: 'epub' };
      } catch { /* unreadable book — try the catalogs */ }
    }
    // 3. The catalogs.
    const url = await (opts.resolveCover || covers.resolveCover)({ title: book.title, author: book.author });
    if (url && url !== book.cover) {
      const hit = await fetchBest(url, opts);
      if (hit) return { ...hit, source: 'catalog' };
    }
  } catch { /* fall back to a generated cover */ }
  return null;
}

/** Forget a book's stored image (e.g. its cover was just changed by hand). */
function invalidate(book, opts = {}) {
  const dir = opts.dir || DIR;
  const key = keyFor(book || {});
  for (const ext of Object.values(EXT_BY_MIME)) {
    try { fs.unlinkSync(path.join(dir, `${key}.${ext}`)); } catch { /* none */ }
  }
}

/** Short version token for an image URL: changes when the stored cover URL
 *  changes, so a hand-fixed cover isn't masked by the browser's cached copy. */
function versionFor(book) {
  return crypto.createHash('sha256').update(String((book && book.cover) || '')).digest('hex').slice(0, 8);
}

/** Express helper: send a resolved cover with cache headers. Real images
 *  cache for a week; a generated one for an hour, so a real cover found later
 *  replaces it soon. */
function send(res, img) {
  res.setHeader('Content-Type', img.mime);
  res.setHeader('Cache-Control', `private, max-age=${img.generated ? 3600 : 604800}`);
  if (img.mime === 'image/svg+xml') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  res.send(img.bytes);
}

module.exports = {
  DIR,
  getCoverImage,
  invalidate,
  versionFor,
  send,
  // exported for tests
  generatedCoverSvg,
  wrapWords,
  keyFor,
  MIN_IMAGE_BYTES,
  GENERATED_TTL_MS,
};
