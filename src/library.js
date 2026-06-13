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

/**
 * @param {Array} entries  history.readAll() — newest-first.
 * @param {(savePath:string)=>boolean} fileExists  whether the .epub is on disk.
 * @returns {Array} books, newest-acquired first:
 *   { id, title, filename, savePath, url, mode, verified, size,
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

// Group books by their file. savePath is the natural identity; fall back to a
// filename-derived key if somehow absent.
function bookKey(entry) {
  if (entry.savePath) return 'p:' + path.resolve(entry.savePath);
  return 'f:' + (entry.filename || '');
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

module.exports = { buildLibrary };
