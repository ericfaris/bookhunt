'use strict';

// Library aggregation: turn the flat history log into a book-centric view.
//
// The raw history (src/history.js) interleaves `search`, `download`, `notify`
// and `reupload` entries newest-first. The Library wants one row per downloaded
// book, each carrying its full send history inline. This module does that shape
// transformation as a PURE function so it's unit-testable without touching the
// filesystem — `fileExists` is injected (the server passes fs.existsSync; tests
// pass a stub).

const path = require('path');
const { matchScore } = require('./correct');
const { authorMatches } = require('./covers');

// A library book's title must match the query at least this well (the same
// variant-aware scorer the spell-corrector + cover lookup use) before we'll claim
// "you already have this". Gating on title (and corroborating author) keeps a
// search for "The Whistler" from matching a stored "Whistler" by a different author.
const LIBRARY_TITLE_THRESHOLD = 0.7;

/**
 * @param {Array} entries  history.readAll() — newest-first.
 * @param {(savePath:string)=>boolean} fileExists  whether the .epub is on disk.
 * @returns {Array} books, newest-acquired first:
 *   { id, title, author, cover, filename, savePath, url, mode, verified, size,
 *     acquiredAt, filePresent, sends: [{ to, channels, kindlePushed, timestamp }] }
 */
function buildLibrary(entries, fileExists = () => true) {
  const list = Array.isArray(entries) ? entries : [];

  // 1. Collect downloaded books that actually produced a file on disk (savePath
  //    set). Standard/external-link "downloads" have no file and can't be
  //    resent, so they're excluded. Dedupe per file: the most recent download
  //    entry for a given savePath is the representative, but we remember every
  //    download id for that file so sends keyed to an older id still correlate.
  const byKey = new Map();
  for (const e of list) {
    if (e.type !== 'download' || !e.savePath) continue;
    const key = bookKey(e);
    let book = byKey.get(key);
    if (!book) {
      // entries are newest-first, so the first one we see is the representative.
      book = {
        id: e.id,
        title: e.title || '',
        author: e.author || authorFromFilename(e.filename) || '',
        cover: e.cover || null,
        filename: e.filename || '',
        savePath: e.savePath,
        url: e.url || null,
        mode: e.mode || 'premium',
        verified: !!e.verified,
        size: e.size || null,
        acquiredAt: e.timestamp,
        _ids: new Set(),
        _filenames: new Set(),
        sends: [],
      };
      byKey.set(key, book);
    }
    if (e.id) book._ids.add(e.id);
    if (e.filename) book._filenames.add(e.filename);
    // Backfill from an older re-download if the representative lacks the field —
    // the newest entry is canonical, but covers/authors fill in where missing.
    if (!book.author && e.author) book.author = e.author;
    if (!book.cover && e.cover) book.cover = e.cover;
  }

  // 2. Attach sends. Prefer an exact downloadId match; fall back to filename for
  //    legacy notify entries written before downloadId was stamped.
  for (const e of list) {
    if (e.type !== 'notify') continue;
    const book = matchSendToBook(e, byKey);
    if (!book) continue;
    book.sends.push({
      to: Array.isArray(e.to) ? e.to : e.to ? [e.to] : [],
      channels: Array.isArray(e.channels) ? e.channels : [],
      kindlePushed: !!e.kindlePushed,
      timestamp: e.timestamp,
    });
  }

  // 3. Finalize: resolve file presence and drop the internal bookkeeping fields.
  const books = [];
  for (const book of byKey.values()) {
    const { _ids, _filenames, ...pub } = book;
    pub.filePresent = !!fileExists(book.savePath);
    // sends were pushed newest-first (entries are newest-first); keep that.
    books.push(pub);
  }
  return books;
}

// Mobilism filenames embed the author in trailing brackets, e.g.
// "Whistler [Ann Patchett].epub". Pull that out so legacy rows (downloaded
// before author was stored) still get an author — which both shows in the UI and
// disambiguates the cover lookup ("Whistler" → Patchett, not Grisham).
function authorFromFilename(filename) {
  if (!filename) return '';
  const base = String(filename).replace(/\.(epub|pdf|mobi|azw3?|rar|zip)$/i, '');
  const m = base.match(/\[([^\]]+)\]\s*$/);
  return m ? m[1].trim() : '';
}

// Group books by their file. savePath is the natural identity; fall back to a
// filename-derived key if somehow absent.
function bookKey(entry) {
  if (entry.savePath) return 'p:' + path.resolve(entry.savePath);
  return 'f:' + (entry.filename || '');
}

/**
 * PURE: remove a downloaded book (and everything correlated to its file) from a
 * flat history list. Identifies the book by a download entry id, then drops ALL
 * download entries sharing that file (re-downloads) plus their sends (by
 * downloadId, or filename for legacy notifies). Returns the surviving entries and
 * the file to delete from disk.
 *
 * @returns {{ entries: Array, savePath: string|null, removed: boolean }}
 */
function removeBook(entries, id) {
  const list = Array.isArray(entries) ? entries : [];
  const target = list.find((e) => e.type === 'download' && e.id === id && e.savePath);
  if (!target) return { entries: list, savePath: null, removed: false };

  const keyPath = path.resolve(target.savePath);
  const ids = new Set();
  const filenames = new Set();
  for (const e of list) {
    if (e.type === 'download' && e.savePath && path.resolve(e.savePath) === keyPath) {
      if (e.id) ids.add(e.id);
      if (e.filename) filenames.add(e.filename);
    }
  }

  const keep = list.filter((e) => {
    if (e.type === 'download' && e.savePath && path.resolve(e.savePath) === keyPath) return false;
    if (e.type === 'notify') {
      if (e.downloadId && ids.has(e.downloadId)) return false;
      if (!e.downloadId && e.filename && filenames.has(e.filename)) return false;
    }
    return true;
  });
  return { entries: keep, savePath: target.savePath, removed: true };
}

// Correlate a notify entry to a book: exact downloadId first, then filename.
function matchSendToBook(notifyEntry, byKey) {
  if (notifyEntry.downloadId) {
    for (const book of byKey.values()) {
      if (book._ids.has(notifyEntry.downloadId)) return book;
    }
  }
  if (notifyEntry.filename) {
    for (const book of byKey.values()) {
      if (book._filenames.has(notifyEntry.filename)) return book;
    }
  }
  return null;
}

/**
 * PURE: find the library books that match a { title, author } query, best first.
 * Used by the search route to surface "you already own this" BEFORE the Mobilism
 * scrape. Title is gated on the variant-aware match score; author (when given)
 * must corroborate. An author-only query returns that author's books. Returns []
 * when nothing matches or the query is empty.
 *
 * `opts.matchScore` / `opts.authorMatches` are injectable for offline tests.
 */
function findInLibrary(books, { title, author } = {}, opts = {}) {
  const list = Array.isArray(books) ? books : [];
  const t = String(title || '').trim();
  const a = String(author || '').trim();
  if (!t && !a) return [];
  const score = opts.matchScore || matchScore;
  const authorOk = opts.authorMatches || authorMatches;

  const scored = [];
  for (const b of list) {
    const tScore = t ? score(t, b.title || '') : 1;
    if (t && tScore < LIBRARY_TITLE_THRESHOLD) continue;
    if (a && !authorOk(a, [b.author || ''])) continue;
    scored.push({ book: b, score: tScore });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.map((s) => s.book);
}

/**
 * Is this {title, author} already on the shelf? Builds the live Library from the
 * on-disk history + tags and matches it with findInLibrary. Shared by the
 * new-release radar (never re-acquire an owned book) and the manual watch API
 * (don't let the user watch something they already have). Fails OPEN — if the
 * lookup throws, returns false so the caller proceeds; the worst case is
 * watching a book you own, which the watcher's own verification catches, rather
 * than silently dropping a legitimate watch. Lazy-requires history/booktags to
 * avoid a load-time dependency cycle through the pure builder above.
 */
function ownsBook(entry) {
  try {
    const history = require('./history');
    const booktags = require('./booktags');
    const books = buildLibrary(history.readAll(), (p) => booktags.readStore()[booktags.keyFor(p)] || []);
    return findInLibrary(books, entry).length > 0;
  } catch {
    return false;
  }
}

module.exports = { buildLibrary, removeBook, authorFromFilename, findInLibrary, ownsBook, LIBRARY_TITLE_THRESHOLD };
