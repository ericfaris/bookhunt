'use strict';

// Regression tests for the buildBooks() copy-paste bug (fixed): the reader
// shelf's book list is built from src/reader.js's buildBooks(), which used to
// pass a TAG LOOKUP where buildLibrary wants a fileExists PREDICATE (so
// filePresent was always true — a "gone" book still offered Send), and never
// attached tags at all (buildLibrary doesn't set `tags`; only
// booktags.attachTags() does). Exercised end-to-end through booksForReaderPage
// (the exported entry point buildBooks feeds), against REAL temp files, so the
// guarantee is about the actual wiring, not a stubbed fileExists.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-reader-buildbooks-'));
process.env.HISTORY_FILE = path.join(TMP, 'history.json');

const { test } = require('node:test');
const assert = require('node:assert');

const history = require('../src/history');
const booktags = require('../src/booktags');
const reader = require('../src/reader');

const RECIPIENT = { id: 'r1', name: 'Alice' };

function resetHistory() {
  fs.writeFileSync(process.env.HISTORY_FILE, '[]');
}

// booktags.js has no env-based file override (unlike history/recipients), so
// point it at a real file on disk that actually exists/doesn't exist as the
// test needs, rather than mutating the live project's booktags.json.
function withTagStore(store, fn) {
  const orig = booktags.readStore;
  booktags.readStore = () => store;
  try {
    return fn();
  } finally {
    booktags.readStore = orig;
  }
}

test('buildBooks (via booksForReaderPage): a book whose file is missing is NOT sendable', async () => {
  resetHistory();
  const missingPath = path.join(TMP, 'this-file-does-not-exist.epub');
  history.add({
    type: 'download',
    title: 'Ghost Book',
    author: 'Nobody',
    cover: 'https://example.com/ghost.jpg', // avoid a live cover-lookup network call in toReaderTile
    savePath: missingPath,
    filename: 'ghost.epub',
    mode: 'premium',
    verified: true,
  });

  const { books } = await reader.booksForReaderPage(RECIPIENT, 0, 10);
  // sendableBooks (verified && filePresent) drives the shelf's source list —
  // a book whose .epub is gone from disk must not appear at all.
  assert.ok(!books.some((b) => b.title === 'Ghost Book'), 'a book with no file on disk must not be offered');
});

test('buildBooks (via booksForReaderPage): a book whose file exists on disk IS sendable', async () => {
  resetHistory();
  const realPath = path.join(TMP, 'real-book.epub');
  fs.writeFileSync(realPath, 'fake epub bytes');
  history.add({
    type: 'download',
    title: 'Real Book',
    author: 'Someone',
    cover: 'https://example.com/real.jpg',
    savePath: realPath,
    filename: 'real-book.epub',
    mode: 'premium',
    verified: true,
  });

  const { books } = await reader.booksForReaderPage(RECIPIENT, 0, 10);
  assert.ok(books.some((b) => b.title === 'Real Book'), 'a book whose file is on disk must be offered');
});

test('buildBooks (via booksForReaderPage): tags attach to reader tiles', async () => {
  resetHistory();
  const realPath = path.join(TMP, 'tagged-book.epub');
  fs.writeFileSync(realPath, 'fake epub bytes');
  history.add({
    type: 'download',
    title: 'Tagged Book',
    author: 'Someone',
    cover: 'https://example.com/tagged.jpg',
    savePath: realPath,
    filename: 'tagged-book.epub',
    mode: 'premium',
    verified: true,
  });

  const store = { [booktags.keyFor(realPath)]: ['sci-fi', 'favorite'] };
  const { books } = await withTagStore(store, () => reader.booksForReaderPage(RECIPIENT, 0, 10));
  const tile = books.find((b) => b.title === 'Tagged Book');
  assert.ok(tile, 'the tagged book must be on the shelf');
  assert.deepEqual(tile.tags, ['sci-fi', 'favorite']);
});
