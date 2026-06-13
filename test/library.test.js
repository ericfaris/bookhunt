'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { buildLibrary } = require('../src/library');

// Helper: history entries are newest-first in real life, so list them that way.
const dl = (over) => ({ type: 'download', mode: 'premium', verified: true, ...over });
const notif = (over) => ({ type: 'notify', ...over });

test('buildLibrary: one row per downloaded file with its metadata', () => {
  const books = buildLibrary([
    dl({ id: 'd1', title: '1984', filename: '1984.epub', savePath: '/dl/1984.epub', size: 1000, url: 'u1' }),
  ]);
  assert.equal(books.length, 1);
  assert.equal(books[0].id, 'd1');
  assert.equal(books[0].title, '1984');
  assert.equal(books[0].savePath, '/dl/1984.epub');
  assert.equal(books[0].sends.length, 0); // never sent
  assert.equal(books[0].filePresent, true); // default fileExists → true
});

test('buildLibrary: excludes standard/external downloads (no savePath)', () => {
  const books = buildLibrary([
    dl({ id: 's1', mode: 'standard', filename: 'rapidgator', savePath: null }),
    dl({ id: 'd1', filename: 'a.epub', savePath: '/dl/a.epub' }),
  ]);
  assert.equal(books.length, 1);
  assert.equal(books[0].id, 'd1');
});

test('buildLibrary: correlates sends by downloadId', () => {
  const books = buildLibrary([
    notif({ downloadId: 'd1', to: ['Alice'], channels: [{ channel: 'email', ok: true }], kindlePushed: true }),
    dl({ id: 'd1', filename: 'a.epub', savePath: '/dl/a.epub' }),
  ]);
  assert.equal(books[0].sends.length, 1);
  assert.deepEqual(books[0].sends[0].to, ['Alice']);
  assert.equal(books[0].sends[0].kindlePushed, true);
});

test('buildLibrary: falls back to filename match for legacy sends (no downloadId)', () => {
  const books = buildLibrary([
    notif({ filename: 'a.epub', to: ['Bob'] }), // legacy: no downloadId
    dl({ id: 'd1', filename: 'a.epub', savePath: '/dl/a.epub' }),
  ]);
  assert.equal(books[0].sends.length, 1);
  assert.deepEqual(books[0].sends[0].to, ['Bob']);
});

test('buildLibrary: dedupes re-downloads of the same file, keeps newest as representative', () => {
  const books = buildLibrary([
    dl({ id: 'd2', filename: 'a.epub', savePath: '/dl/a.epub', timestamp: '2026-06-13T10:00:00Z' }), // newest first
    dl({ id: 'd1', filename: 'a.epub', savePath: '/dl/a.epub', timestamp: '2026-06-12T10:00:00Z' }),
    // a send keyed to the OLDER download id must still correlate to the row.
    notif({ downloadId: 'd1', to: ['Carol'] }),
  ]);
  assert.equal(books.length, 1, 'same file collapses to one book');
  assert.equal(books[0].id, 'd2', 'representative is the most recent download');
  assert.equal(books[0].sends.length, 1);
  assert.deepEqual(books[0].sends[0].to, ['Carol']);
});

test('buildLibrary: flags a missing file via injected fileExists', () => {
  const present = new Set(['/dl/here.epub']);
  const books = buildLibrary(
    [
      dl({ id: 'd1', filename: 'here.epub', savePath: '/dl/here.epub' }),
      dl({ id: 'd2', filename: 'gone.epub', savePath: '/dl/gone.epub' }),
    ],
    (p) => present.has(p)
  );
  const here = books.find((b) => b.id === 'd1');
  const gone = books.find((b) => b.id === 'd2');
  assert.equal(here.filePresent, true);
  assert.equal(gone.filePresent, false);
});

test('buildLibrary: multiple sends accumulate on one book', () => {
  const books = buildLibrary([
    notif({ downloadId: 'd1', to: ['Alice'] }),
    notif({ downloadId: 'd1', to: ['Bob'] }),
    dl({ id: 'd1', filename: 'a.epub', savePath: '/dl/a.epub' }),
  ]);
  assert.equal(books[0].sends.length, 2);
});

test('buildLibrary: a send with no matching book is ignored (not thrown)', () => {
  const books = buildLibrary([
    notif({ downloadId: 'ghost', to: ['Nobody'] }),
    dl({ id: 'd1', filename: 'a.epub', savePath: '/dl/a.epub' }),
  ]);
  assert.equal(books[0].sends.length, 0);
});

test('buildLibrary: empty / non-array input yields []', () => {
  assert.deepEqual(buildLibrary([]), []);
  assert.deepEqual(buildLibrary(undefined), []);
  assert.deepEqual(buildLibrary(null), []);
});
