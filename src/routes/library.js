'use strict';

// Library routes: history, the book-centric Library, tags, covers (stored
// images + catalog lookups) and Send.

const path = require('path');
const express = require('express');

const downloader = require('../downloader');
const history = require('../history');
const recipients = require('../recipients');
const notify = require('../notify');
const library = require('../library');
const booktags = require('../booktags');
const covers = require('../covers');
const coverstore = require('../coverstore');
const storage = require('../storage');
const delivery = require('../delivery');

const router = express.Router();

// --- History ----------------------------------------------------------------
router.get('/api/history', (_req, res) => {
  res.json({ entries: history.readAll() });
});

// --- Library: book-centric view with inline send history -------------------
// Reshapes the flat history into one row per downloaded book, each carrying its
// sends. `filePresent` reflects whether the .epub is still on disk so the client
// can disable resend for files that have been removed. Existence goes through
// the storage layer (local disk, or the R2 key index — one list, never a HEAD
// per book).
router.get('/api/library', async (_req, res) => {
  const books = (await library.loadBooks()).map((b) => ({ ...b, coverImage: libraryCoverUrl(b) }));
  const store = booktags.readStore();
  res.json({ books: booktags.attachTags(books, store), allTags: booktags.allTags(store) });
});

// Delete a library book: remove its file from disk (when safe + present) and
// drop its download + correlated send entries from history. Tags for that file
// are dropped too. Idempotent-ish: a missing file still clears the history rows.
router.delete('/api/library/:id', async (req, res) => {
  let savePath = null;
  let removed = false;
  history.mutate((entries) => {
    const r = library.removeBook(entries, req.params.id);
    savePath = r.savePath;
    removed = r.removed;
    return removed ? r.entries : false; // nothing found → don't rewrite the file
  });
  if (!removed) return res.status(404).json({ error: 'Library book not found.' });
  let fileDeleted = false;
  if (savePath && downloader.isSafeEpubPath(savePath, downloader.DOWNLOAD_PATH)) {
    // true iff the file was there (local disk, or the R2 key index).
    try {
      fileDeleted = await storage.get().remove(savePath);
    } catch (err) {
      console.error('Library delete: file removal failed:', err.message);
    }
  }
  try { booktags.setTags(savePath, []); } catch { /* best effort */ }
  res.json({ ok: true, fileDeleted });
});

// Set the tags for a library book (identified by its download id).
router.put('/api/library/:id/tags', (req, res) => {
  const entry = history.findDownload(req.params.id, { withFile: true });
  if (!entry) return res.status(404).json({ error: 'Library book not found.' });
  const tags = booktags.setTags(entry.savePath, (req.body && req.body.tags) || []);
  res.json({ ok: true, tags });
});

// Update a library book's cover when it's wrong. Two modes:
//   - { cover: "https://…" }  → set that exact image, OR
//   - { refetch: true } / no cover → re-resolve from the catalog (FRESH, cache-
//     bypassed, by title+author). The new cover is written to EVERY download
//     entry for the same file so re-downloads stay consistent. Returns the cover.
router.put('/api/library/:id/cover', async (req, res) => {
  const target = history.findDownload(req.params.id, { withFile: true });
  if (!target) return res.status(404).json({ error: 'Library book not found.' });

  let cover = typeof (req.body && req.body.cover) === 'string' ? req.body.cover.trim() : '';
  if (cover) {
    if (!/^https:\/\//i.test(cover)) {
      return res.status(400).json({ error: 'Cover must be an https image URL.' });
    }
    if (cover.length > 2000) return res.status(400).json({ error: 'That URL is too long.' });
  } else {
    // Re-fetch from the catalog, bypassing the cache so a previously-wrong cover
    // can't be re-served. lookupCover hits the network directly.
    try {
      cover = (await covers.lookupCover({ title: target.title, author: target.author })) || '';
    } catch { cover = ''; }
    if (!cover) {
      return res.status(422).json({ error: 'Couldn’t find a cover automatically — paste an image URL instead.' });
    }
  }

  // Apply the cover against a FRESH read — the catalog lookup above is a network
  // round-trip, and a snapshot taken before it would be stale by now: writing it
  // back would erase anything the watcher/radar appended while we waited.
  const keyPath = path.resolve(target.savePath);
  history.mutate((entries) => {
    for (const e of entries) {
      if (e.type === 'download' && e.savePath && path.resolve(e.savePath) === keyPath) e.cover = cover;
    }
  });
  // Drop the stored image so the next load re-resolves from the new cover (the
  // client re-requests it with a fresh cache-busting token).
  coverstore.invalidate({ title: target.title, author: target.author || library.authorFromFilename(target.filename) || '' });
  res.json({ ok: true, cover });
});

// --- Cover images (stored; see src/coverstore.js) ------------------------------
// Every cover the operator app shows loads from one of these, never straight
// from a catalog: the image is found once (stored URL → the ePUB's own cover →
// catalog chain → generated jacket), saved to disk, and served from there.
// Outside /api so a Library full of images doesn't eat the API rate limit.
function libraryCoverUrl(book) {
  return `/cover-image/book/${encodeURIComponent(book.id)}?v=${coverstore.versionFor(book)}`;
}

router.get('/cover-image/book/:id', async (req, res) => {
  try {
    const book = (await library.loadBooks()).find((b) => b.id === req.params.id);
    if (!book) return res.status(404).end();
    coverstore.send(res, await coverstore.getCoverImage(book));
  } catch (err) {
    console.error('Cover image failed:', err);
    res.status(500).end();
  }
});

// Books that aren't in the Library (search results, watchlist): same chain
// minus the ePUB step. `cover` is an optional known URL to try first.
router.get('/cover-image/lookup', async (req, res) => {
  const str = (v) => (typeof v === 'string' ? v.slice(0, 300) : '');
  const title = str(req.query.title);
  const author = str(req.query.author);
  const cover = /^https:\/\//i.test(str(req.query.cover)) ? str(req.query.cover) : null;
  if (!title.trim() && !author.trim() && !cover) return res.status(400).end();
  try {
    coverstore.send(res, await coverstore.getCoverImage({ title, author, cover }, { epub: false }));
  } catch (err) {
    console.error('Cover lookup image failed:', err);
    res.status(500).end();
  }
});

// --- Cover lookup: lazy per-book cover for Library rows lacking one ----------
// The client calls this only for rows scrolled into view (IntersectionObserver),
// so we never fan out lookups for the whole library at once. Results are cached
// to disk (src/covers.js) so a given book is looked up at most once. Fails soft:
// any miss/error returns { cover: null }.
router.get('/api/cover', async (req, res) => {
  const title = typeof req.query.title === 'string' ? req.query.title : '';
  const author = typeof req.query.author === 'string' ? req.query.author : '';
  if (!title.trim() && !author.trim()) return res.json({ cover: null });
  try {
    const cover = await covers.resolveCover({ title, author });
    res.json({ cover: cover || null });
  } catch {
    res.json({ cover: null });
  }
});

// --- Book metadata (cover + blurb) ------------------------------------------
// Like /api/cover, but also returns the catalog blurb. Used by the result card
// when a book was found inside a SET/collection: the forum post's title, cover
// and blurb describe the whole set, so we look up the actual searched book's own
// artwork + synopsis here (disk-cached via covers.resolveMeta). Fails soft.
router.get('/api/meta', async (req, res) => {
  const title = typeof req.query.title === 'string' ? req.query.title.slice(0, 300) : '';
  const author = typeof req.query.author === 'string' ? req.query.author.slice(0, 300) : '';
  if (!title.trim() && !author.trim()) return res.json({ cover: null, description: null });
  try {
    const meta = await covers.resolveMeta({ title, author });
    res.json({ cover: meta.cover || null, description: meta.description || null });
  } catch {
    res.json({ cover: null, description: null });
  }
});


// --- Send: notify recipients (+ optional Kindle push) -----------------------
router.post('/api/send', async (req, res) => {
  const { downloadId, recipientIds, channels, book } = req.body || {};
  if (!downloadId) return res.status(400).json({ error: 'Missing downloadId.' });
  if (!Array.isArray(recipientIds) || !recipientIds.length) {
    return res.status(400).json({ error: 'Pick at least one recipient.' });
  }

  // Resolve the file via history (never trust a client-supplied path) and make
  // sure it lives inside DOWNLOAD_PATH and is an .epub before attaching it.
  const entry = history.findDownload(downloadId);
  if (!entry || !entry.savePath) return res.status(404).json({ error: 'Download not found.' });
  if (!downloader.isSafeEpubPath(entry.savePath, downloader.DOWNLOAD_PATH)) {
    return res.status(400).json({ error: 'Refusing to send that file.' });
  }
  // Existence via storage (#47): local = fs.existsSync of the resolved path;
  // r2 = the key index (loaded once, no per-send HEAD).
  const store = storage.get();
  await store.ensureIndex();
  if (!store.existsSync(entry.savePath)) {
    return res.status(410).json({ error: 'File no longer exists on disk.' });
  }

  const recips = recipients.byIds(recipientIds);
  if (!recips.length) return res.status(404).json({ error: 'No matching recipients.' });

  // Build the book info for the email, preferring what the client passed, then
  // the stored download entry. A resend from the Library/batch carries only a
  // title, so author/cover/blurb are often missing here — derive the author from
  // the Mobilism "[Author]" filename so enrichment can disambiguate.
  const author = (book && book.author) || entry.author || library.authorFromFilename(entry.filename) || '';
  const bookInfo = {
    // The stored entry's title is cleaned + title-cased at ingest; the client's
    // copy is often the raw search-box text ("every summer after").
    title: entry.title || (book && book.title) || '',
    author,
    cover: (book && book.cover) || entry.cover || null,
    description: (book && book.description) || '',
    filename: entry.filename,
  };
  // Fill any missing cover/blurb so the email always has artwork + a synopsis
  // (author-gated — see delivery.fillMissingMeta), then attach the stored
  // cover image the Library shows.
  await delivery.fillMissingMeta(bookInfo);
  await delivery.attachEmailCover(bookInfo, { savePath: entry.savePath, filePresent: true });

  // The attachment is fetched at most once per send (not per recipient). A
  // fetch failure surfaces as each recipient's Kindle error, never a 500.
  const getAttachment = delivery.attachmentLoader(entry.savePath, store);
  const results = [];
  for (const r of recips) {
    const out = { id: r.id, name: r.name, kindle: null, channels: [] };
    // Always pushed when the recipient has a Kindle address.
    out.kindle = await delivery.pushToKindle(r, { filename: entry.filename, getAttachment });

    out.channels = await notify.notify(r, { ...bookInfo, pushedToKindle: !!(out.kindle && out.kindle.ok) }, channels);

    history.logNotify({
      downloadId,
      title: bookInfo.title || entry.title,
      filename: entry.filename,
      to: [r.name],
      kindlePushed: !!(out.kindle && out.kindle.ok),
      channels: out.channels,
    });
    results.push(out);
  }

  res.json({ results });
});

module.exports = router;
