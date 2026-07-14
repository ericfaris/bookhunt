'use strict';

// Integration test for the REAL /api/library/:id/cover route.
//
// Regression: the route read all of history, then awaited a NETWORK cover lookup
// (seconds), then wrote that pre-lookup snapshot back — so any book the watcher
// downloaded, or any Kindle send logged, while the lookup was in flight was
// silently erased from the Library. Point the stores at temp files and disable
// Cloudflare Access BEFORE requiring the app so we can hit it in-process.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-lib-'));
process.env.HISTORY_FILE = path.join(TMP, 'history.json');
process.env.RECIPIENTS_FILE = path.join(TMP, 'recipients.json');
process.env.CF_ACCESS_TEAM_DOMAIN = '';
process.env.CF_ACCESS_AUD = '';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const history = require('../src/history');
const covers = require('../src/covers');
const { app } = require('../src/server');

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function put(port, path_, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: path_, method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch { /* ignore */ }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

test('/api/library/:id/cover: a book acquired DURING the cover lookup is not erased', async () => {
  fs.writeFileSync(process.env.HISTORY_FILE, '[]');
  const book = history.add({
    type: 'download', title: 'Old Book', author: 'A', savePath: '/downloads/old.epub',
    filename: 'old.epub', mode: 'premium', verified: true,
  });

  const origLookup = covers.lookupCover;
  // A slow lookup that, mid-flight, appends a download — exactly what the
  // background watcher does on its 5-minute tick.
  covers.lookupCover = async () => {
    await new Promise((r) => setTimeout(r, 30));
    history.add({
      type: 'download', title: 'Saved By A God', author: 'Michelle Heard',
      savePath: '/downloads/saved.epub', filename: 'saved.epub', mode: 'premium', verified: true,
    });
    await new Promise((r) => setTimeout(r, 10));
    return 'https://covers/new.jpg';
  };

  const server = await listen();
  try {
    const { status, json } = await put(server.address().port, `/api/library/${book.id}/cover`, { refetch: true });
    assert.equal(status, 200);
    assert.equal(json.cover, 'https://covers/new.jpg');
  } finally {
    covers.lookupCover = origLookup;
    server.close();
  }

  const after = history.readAll();
  const titles = after.map((e) => e.title);
  assert.ok(
    titles.includes('Saved By A God'),
    'the book the watcher acquired during the lookup must still be in the Library'
  );
  // …and the cover we went to fetch was still applied to the target book.
  assert.equal(after.find((e) => e.id === book.id).cover, 'https://covers/new.jpg');
});

test('/api/library/:id/cover: 404 for an unknown book, and history is untouched', async () => {
  fs.writeFileSync(process.env.HISTORY_FILE, '[]');
  history.add({ type: 'download', title: 'Keep', savePath: '/downloads/k.epub' });
  const before = fs.readFileSync(process.env.HISTORY_FILE, 'utf8');

  const server = await listen();
  try {
    const { status } = await put(server.address().port, '/api/library/nope/cover', { cover: 'https://x/y.jpg' });
    assert.equal(status, 404);
  } finally {
    server.close();
  }
  assert.equal(fs.readFileSync(process.env.HISTORY_FILE, 'utf8'), before);
});
