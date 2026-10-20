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
//   4. a generated cover — title + author typeset on a colored jacket (SVG;
//      converted to PNG for email by getEmailCoverImage)
//
// Real images are normalized on the way in (optimizeImage: fit 900×1350,
// JPEG) so a 3 MB embedded ePUB cover is stored at roughly 100 KB.
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
// Stored covers are normalized to at most this size (a 2:3 jacket that still
// looks sharp at the mega view's ~760px tall on a 2x screen) and re-encoded as
// JPEG when bigger than OPTIMIZE_OVER_BYTES. Embedded ePUB covers run to
// 3+ MB; after this they're typically 50–150 KB.
const MAX_W = 900;
const MAX_H = 1350;
const OPTIMIZE_OVER_BYTES = 350 * 1024;
// A cover narrower than this looks soft in the mega view (and on 2x screens
// even as a tile). The chain treats it as a fallback and keeps looking for a
// better source; only if none exists is the small one used.
const MIN_GOOD_W = 400;
// Bumped when stored images get materially better (e.g. the 2026-10 upgrade
// from 128px catalog thumbnails), so browsers drop their week-long cached copy.
const COVER_REV = '2';
// Distinct catalog cover URLs tried per book before falling back.
const CATALOG_ATTEMPTS = 4;
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

/**
 * True for Google Books' "image not available" stand-in: it's served as a
 * normal 200 image, so it must be recognized by content — a light, perfectly
 * gray picture (gray text on white). Fails soft (false) without sharp.
 */
async function isPlaceholderImage(bytes, opts = {}) {
  const sharp = opts.sharp === undefined ? loadSharp() : opts.sharp;
  if (!sharp) return false;
  try {
    const { channels } = await sharp(bytes).removeAlpha().stats();
    if (channels.length < 3) return false;
    const [r, g, b] = channels;
    const close = (x, y) => Math.abs(x - y) < 1.5;
    return r.mean > 200 && close(r.mean, g.mean) && close(g.mean, b.mean)
      && close(r.stdev, g.stdev) && close(g.stdev, b.stdev);
  } catch {
    return false;
  }
}

const GOOGLE_IMG_HOST = /^https?:\/\/books\.google(usercontent)?\.com\//i;

/** Fetch a remote cover and accept it only if it's a real image. */
async function fetchImage(url, opts) {
  if (!url) return null;
  const bytes = await (opts.fetchImage || covers.fetchCoverImage)(url);
  if (!bytes || bytes.length < MIN_IMAGE_BYTES || bytes.length > MAX_IMAGE_BYTES) return null;
  const mime = epub.sniffImageMime(bytes);
  if (!mime) return null;
  if (GOOGLE_IMG_HOST.test(url) && (await isPlaceholderImage(bytes, opts))) return null;
  return { bytes, mime };
}

/** Try the large rendition of a URL first, then the URL as given. */
async function fetchBest(url, opts) {
  const large = covers.largeCoverUrl(url);
  return (large && large !== url && (await fetchImage(large, opts))) || fetchImage(url, opts);
}

// --- Image processing (sharp, lazy + fail-soft) -------------------------------

let sharpLib;
function loadSharp() {
  if (sharpLib === undefined) {
    try { sharpLib = require('sharp'); } catch { sharpLib = null; }
  }
  return sharpLib;
}

/**
 * Shrink an oversized cover: fit inside MAX_W×MAX_H and re-encode as JPEG.
 * Only kicks in above OPTIMIZE_OVER_BYTES or the size limits, and only keeps
 * the result when it's actually smaller. Any failure (no sharp, corrupt image)
 * returns the original unchanged. NEVER throws.
 */
async function optimizeImage(img, opts = {}) {
  const sharp = opts.sharp === undefined ? loadSharp() : opts.sharp;
  if (!sharp || !img || img.mime === 'image/svg+xml') return img;
  try {
    const meta = await sharp(img.bytes).metadata();
    const tooBig = img.bytes.length > OPTIMIZE_OVER_BYTES || (meta.width || 0) > MAX_W || (meta.height || 0) > MAX_H;
    if (!tooBig) return img;
    const out = await sharp(img.bytes)
      .rotate() // honor EXIF orientation before it's stripped
      .resize({ width: MAX_W, height: MAX_H, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }) // JPEG has no alpha
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    return out.length < img.bytes.length ? { ...img, bytes: out, mime: 'image/jpeg' } : img;
  } catch {
    return img;
  }
}

/** A generated SVG jacket as PNG, for email clients (which don't render SVG).
 *  Real images pass through. Falls back to the input on any failure. */
async function rasterize(img, opts = {}) {
  const sharp = opts.sharp === undefined ? loadSharp() : opts.sharp;
  if (!sharp || !img || img.mime !== 'image/svg+xml') return img;
  try {
    const bytes = await sharp(img.bytes, { density: 144 }).resize({ width: 600 }).png().toBuffer();
    return { ...img, bytes, mime: 'image/png' };
  } catch {
    return img;
  }
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
// Small stored covers already given an upgrade attempt in this process.
const upgradeTried = new Set();

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
    let img = null;
    try {
      img = { bytes: fs.readFileSync(stored.file), mime: stored.mime, source: 'stored', generated: stored.generated };
    } catch { /* fall through and rebuild */ }
    if (img) {
      // Covers stored before images were normalized get shrunk once, in place.
      if (!img.generated && img.bytes.length > OPTIMIZE_OVER_BYTES) {
        const small = await optimizeImage(img, opts);
        if (small !== img) { writeStored(key, dir, small.bytes, small.mime); return small; }
      }
      // A stored "image not available" placeholder (saved before those were
      // rejected) is dropped once per process so the chain can find the real one.
      const checkKey = 'ph|' + dir + '|' + key;
      if (!img.generated && img.bytes.length < 120 * 1024 && !upgradeTried.has(checkKey)) {
        upgradeTried.add(checkKey);
        if (await isPlaceholderImage(img.bytes, opts)) return rebuildCover(book || {}, key, dir, opts);
      }
      // A low-res cover (e.g. a 128px catalog thumbnail stored before the
      // chain became quality-aware) gets one upgrade attempt per process.
      const flight = dir + '|' + key;
      const lowRes = !img.generated && !upgradeTried.has(flight) && img.bytes.length < 120 * 1024
        ? await widthOf(img.bytes, opts) : 0;
      if (lowRes > 0 && lowRes < MIN_GOOD_W) {
        upgradeTried.add(flight);
        const better = await findRealCover(book || {}, opts);
        if (better && (better.width || 0) > lowRes) {
          const found = await optimizeImage(better, opts);
          writeStored(key, dir, found.bytes, found.mime);
          return { ...found, generated: false };
        }
      }
      return img;
    }
  }

  return rebuildCover(book || {}, key, dir, opts);
}

/** Run the chain for a book and store the result (real cover, else generated). */
function rebuildCover(book, key, dir, opts) {
  const flightKey = dir + '|' + key;
  if (inflight.has(flightKey)) return inflight.get(flightKey);
  const p = (async () => {
    const raw = await findRealCover(book || {}, opts);
    const found = raw && (await optimizeImage(raw, opts));
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

/** Pixel width of an image (0 when unknown — sharp missing or unreadable). */
async function widthOf(bytes, opts = {}) {
  const sharp = opts.sharp === undefined ? loadSharp() : opts.sharp;
  if (!sharp) return 0;
  try { return (await sharp(bytes).metadata()).width || 0; } catch { return 0; }
}

/**
 * Steps 1–3 of the chain; null when none produced a real image. Quality-aware:
 * the first image at least MIN_GOOD_W wide wins; a smaller one is remembered
 * and the chain keeps looking, falling back to the widest seen. (When width
 * can't be measured, the first hit wins, as before.)
 */
async function findRealCover(book, opts) {
  let best = null;
  const consider = async (hit, source) => {
    if (!hit) return false;
    const width = await widthOf(hit.bytes, opts);
    const cand = { ...hit, source, width };
    if (!width || width >= MIN_GOOD_W) { best = cand; return true; }
    if (!best || width > (best.width || 0)) best = cand;
    return false;
  };
  try {
    // 1. The cover stored with the download.
    if (book.cover && (await consider(await fetchBest(book.cover, opts), 'stored-url'))) return best;
    // 2. The cover inside the ePUB.
    if (book.savePath && book.filePresent !== false && opts.epub !== false) {
      try {
        const buf = await (opts.readBook || ((p) => storage.get().getBuffer(p)))(book.savePath);
        const hit = epub.extractCoverImage(buf);
        if (hit && hit.bytes.length >= MIN_IMAGE_BYTES && (await consider(hit, 'epub'))) return best;
      } catch { /* unreadable book — try the catalogs */ }
    }
    // 3. The catalogs.
    // A source can answer with a dead or placeholder image; keep asking the
    // chain for a different URL (bypassing the cache) before giving up.
    const q = { title: book.title, author: book.author };
    const skipUrls = new Set(book.cover ? [book.cover] : []);
    let url = await (opts.resolveCover || covers.resolveCover)(q);
    for (let i = 0; url && i < CATALOG_ATTEMPTS; i++) {
      if (!skipUrls.has(url)) {
        skipUrls.add(url);
        const hit = await fetchBest(url, opts);
        if (await consider(hit, 'catalog')) {
          if (i > 0) (opts.rememberCover || covers.rememberCover)(q, url);
          return best;
        }
      }
      url = await (opts.lookupCover || covers.lookupCover)(q, { skipUrls });
    }
  } catch { /* fall back to whatever we have, else a generated cover */ }
  return best;
}

/**
 * The cover for an EMAIL: same chain as getCoverImage, but a generated SVG
 * jacket is rasterized to PNG (Gmail and most clients won't show SVG), so
 * every email gets a real cover image. NEVER throws (null on total failure).
 */
async function getEmailCoverImage(book, opts = {}) {
  try {
    return await rasterize(await getCoverImage(book, opts), opts);
  } catch {
    return null;
  }
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
  return crypto.createHash('sha256').update(COVER_REV + '|' + String((book && book.cover) || '')).digest('hex').slice(0, 8);
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
  getEmailCoverImage,
  invalidate,
  versionFor,
  send,
  // exported for tests
  generatedCoverSvg,
  wrapWords,
  optimizeImage,
  rasterize,
  isPlaceholderImage,
  OPTIMIZE_OVER_BYTES,
  MIN_GOOD_W,
  MAX_W,
  MAX_H,
  keyFor,
  MIN_IMAGE_BYTES,
  GENERATED_TTL_MS,
};
