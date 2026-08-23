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
