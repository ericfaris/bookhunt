'use strict';

// Integration test for GET /api/watchlist's sort order.
//
// Regression: the watchlist rendered in file (insertion) order — oldest first
// — so a freshly-added watch landed at the bottom of a long list instead of
// where you'd look for it. Point the store at a temp file BEFORE requiring the
// app so we can seed a controlled set of watches without touching the live
// watchlist.json.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-watchlist-'));
process.env.WATCHLIST_FILE = path.join(TMP, 'watchlist.json');
process.env.HISTORY_FILE = path.join(TMP, 'history.json');
process.env.RECIPIENTS_FILE = path.join(TMP, 'recipients.json');
process.env.CF_ACCESS_TEAM_DOMAIN = '';
process.env.CF_ACCESS_AUD = '';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const watchlist = require('../src/watchlist');
const { app } = require('../src/server');

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function get(port, path_) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: path_ }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* ignore */ }
        resolve({ status: res.statusCode, json });
      });
    }).on('error', reject);
  });
}

test('GET /api/watchlist: returns watches newest-added first', async () => {
  fs.writeFileSync(process.env.WATCHLIST_FILE, '[]');
  const oldest = watchlist.add({ title: 'Oldest', author: 'A' });
  await new Promise((r) => setTimeout(r, 5));
  const middle = watchlist.add({ title: 'Middle', author: 'B' });
  await new Promise((r) => setTimeout(r, 5));
  const newest = watchlist.add({ title: 'Newest', author: 'C' });

  const server = await listen();
  try {
    const { status, json } = await get(server.address().port, '/api/watchlist');
    assert.equal(status, 200);
    assert.deepEqual(
      json.watches.map((w) => w.id),
      [newest.id, middle.id, oldest.id]
    );
  } finally {
    server.close();
  }
});

// --- Watches for books already in the Library (critique 2026-10-27) -----------
// Regression: a watch sat in its download-retry backoff ("Found — retrying,
// next try 10/30") while the same book, downloaded by hand, was first in the
// Library. GET now closes such watches before answering.

const history = require('../src/history');
const watcher = require('../src/watcher');

function seedLibrary() {
  fs.writeFileSync(process.env.HISTORY_FILE, '[]');
  history.add({
    type: 'download', title: 'Lady Tremaine', author: 'Rachel Hochhauser',
    savePath: path.join(TMP, 'lt.epub'), filename: 'lt.epub', mode: 'premium', verified: true,
  });
}

test('GET /api/watchlist: closes a retrying watch whose book is already in the Library', async () => {
  seedLibrary();
  fs.writeFileSync(process.env.WATCHLIST_FILE, '[]');
  const w = watchlist.add({ title: 'Lady Tremaine', author: 'Rachel Hochhauser' });
  watchlist.update(w.id, { downloadMisses: 5, retryAfter: '2026-10-30T00:00:00Z', lastError: 'No Premium icon found' });
  const other = watchlist.add({ title: 'Some Unowned Book', author: 'Nobody' });

  const server = await listen();
  try {
    const { status, json } = await get(server.address().port, '/api/watchlist');
    assert.equal(status, 200);
    const got = json.watches.find((x) => x.id === w.id);
    assert.equal(got.status, 'fulfilled');
    assert.equal(got.fulfilledBy, 'library');
    assert.equal(got.retryAfter, null);
    assert.equal(got.lastError, null);
    assert.equal(json.watches.find((x) => x.id === other.id).status, 'active', 'unowned watch untouched');
    assert.equal(json.maxDownloadMisses, watcher.MAX_DOWNLOAD_MISSES, 'UI gets the retry cap for "n/6"');
  } finally {
    server.close();
  }
});

test('reconcileOwned: skips author-only, expired and unowned watches; closes paused owned ones', () => {
  fs.writeFileSync(process.env.WATCHLIST_FILE, '[]');
  const authorOnly = watchlist.add({ author: 'Rachel Hochhauser' });
  const owned = watchlist.add({ title: 'Owned Title', author: 'X' });
  const paused = watchlist.add({ title: 'Paused Owned', author: 'Y' });
  watchlist.setStatus(paused.id, 'paused');
  const expired = watchlist.add({ title: 'Expired Owned', author: 'Z' });
  watchlist.setStatus(expired.id, 'expired');
  const unowned = watchlist.add({ title: 'Not Mine', author: 'Q' });

  const asked = [];
  const owns = (e) => { asked.push(e.title); return /Owned/.test(e.title); };
  const closed = watcher.reconcileOwned(owns);

  assert.deepEqual(closed.sort(), [owned.id, paused.id].sort());
  assert.ok(!asked.includes(undefined) && !asked.includes(''), 'author-only watch never matched');
  const byId = Object.fromEntries(watchlist.readAll().map((w) => [w.id, w]));
  assert.equal(byId[authorOnly.id].status, 'active');
  assert.equal(byId[expired.id].status, 'expired');
  assert.equal(byId[unowned.id].status, 'active');
  assert.equal(byId[owned.id].fulfilledBy, 'library');
});

test('reconcileOwned: resuming a library-closed watch clears fulfilledBy', () => {
  fs.writeFileSync(process.env.WATCHLIST_FILE, '[]');
  const w = watchlist.add({ title: 'Owned Again', author: 'X' });
  watcher.reconcileOwned(() => true);
  watchlist.setStatus(w.id, 'active');
  const got = watchlist.readAll().find((x) => x.id === w.id);
  assert.equal(got.status, 'active');
  assert.equal(got.fulfilledBy, null);
});
