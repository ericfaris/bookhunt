'use strict';

// library.currentBooks()/loadBooks(): the one place the Library is assembled
// from history + the storage layer (formerly pasted at five call sites).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const history = require('../src/history');
const storage = require('../src/storage');
const library = require('../src/library');

function withDriver(t, driver) {
  storage._setDriver(driver);
  t.after(() => storage._setDriver(null));
}

const dl = (id, title, savePath) => ({ id, type: 'download', title, author: 'A', savePath, filename: savePath.split('/').pop(), timestamp: '2026-10-01T00:00:00Z' });

test('currentBooks: history downloads become books, presence from the storage driver', (t) => {
  fs.writeFileSync(process.env.HISTORY_FILE, JSON.stringify([
    dl('1', 'Here', '/downloads/Here [A].epub'),
    dl('2', 'Gone', '/downloads/Gone [A].epub'),
    { id: '3', type: 'search', title: 'not a book' },
  ]));
  withDriver(t, { existsSync: (p) => p.includes('Here'), ensureIndex: async () => {} });
  const books = library.currentBooks();
  assert.deepEqual(books.map((b) => [b.title, b.filePresent]).sort(), [['Gone', false], ['Here', true]]);
});

test('loadBooks: loads the storage index BEFORE checking presence (r2 cold start)', async (t) => {
  fs.writeFileSync(process.env.HISTORY_FILE, JSON.stringify([dl('1', 'Here', '/downloads/Here [A].epub')]));
  let indexed = false;
  withDriver(t, {
    ensureIndex: async () => { await new Promise((r) => setTimeout(r, 5)); indexed = true; },
    existsSync: () => indexed, // an unloaded index would report every book missing
  });
  const books = await library.loadBooks();
  assert.equal(books[0].filePresent, true);
});

test('ownsBook: matches on title/author via currentBooks, fails open (false) on errors', (t) => {
  fs.writeFileSync(process.env.HISTORY_FILE, JSON.stringify([dl('1', 'Heart of Glass', '/downloads/Heart of Glass [A].epub')]));
  withDriver(t, { existsSync: () => true });
  assert.equal(library.ownsBook({ title: 'Heart of Glass', author: 'A' }), true);
  assert.equal(library.ownsBook({ title: 'Something Else', author: 'A' }), false);
  withDriver(t, { existsSync: () => { throw new Error('boom'); } });
  assert.equal(library.ownsBook({ title: 'Heart of Glass', author: 'A' }), false);
});

test('history and library agree after a logged download (no stale snapshot)', (t) => {
  fs.writeFileSync(process.env.HISTORY_FILE, '[]');
  withDriver(t, { existsSync: () => true });
  history.logDownload({ title: 'New One', author: 'A', filename: 'New One [A].epub', savePath: '/downloads/New One [A].epub', mode: 'premium', verified: true });
  assert.deepEqual(library.currentBooks().map((b) => b.title), ['New One']);
});
