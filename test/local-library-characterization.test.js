'use strict';

// Characterization tests (issue #47): pin TODAY's local-disk behaviour of the
// Library routes BEFORE the storage abstraction refactor, so the refactor can
// be proven not to change it. Written and passing against the unmodified code;
// must stay green, unchanged, after every storage task.
//
// Env is pointed at temp dirs/files BEFORE requiring the app (DOWNLOAD_PATH is
// captured at module load by the downloader).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-libchar-'));
const DL = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-libchar-dl-'));
process.env.DOWNLOAD_PATH = DL;
process.env.HISTORY_FILE = path.join(TMP, 'history.json');
process.env.RECIPIENTS_FILE = path.join(TMP, 'recipients.json');
process.env.WATCHLIST_FILE = path.join(TMP, 'watchlist.json');
process.env.CF_ACCESS_TEAM_DOMAIN = '';
process.env.CF_ACCESS_AUD = '';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const history = require('../src/history');
const booktags = require('../src/booktags');
const { app } = require('../src/server');
const { request, withServer } = require('./http-helpers');

// booktags.js has no env-based file override, so never let it touch the
// project's real booktags.json: stub its disk-touching functions per test.
let origReadStore;
let origSetTags;
let setTagsCalls;
beforeEach(() => {
  fs.writeFileSync(process.env.HISTORY_FILE, '[]');
  origReadStore = booktags.readStore;
  origSetTags = booktags.setTags;
  setTagsCalls = [];
  booktags.readStore = () => ({});
  booktags.setTags = (savePath, tags) => { setTagsCalls.push([savePath, tags]); return tags; };
});
afterEach(() => {
  booktags.readStore = origReadStore;
  booktags.setTags = origSetTags;
});

function addDownload(savePath, extra = {}) {
  return history.add({
    type: 'download', title: extra.title || path.basename(savePath), author: 'A',
    savePath, filename: path.basename(savePath), mode: 'premium', verified: true, ...extra,
  });
}

test('local GET /api/library: filePresent reflects whether the file exists on disk', async () => {
  const present = path.join(DL, 'Present [A].epub');
  fs.writeFileSync(present, 'bytes');
  const missing = path.join(DL, 'Missing [A].epub');
  addDownload(present, { title: 'Present' });
  addDownload(missing, { title: 'Missing' });

  await withServer(app, async (port) => {
    const { status, json } = await request(port, 'GET', '/api/library');
    assert.equal(status, 200);
    const byTitle = Object.fromEntries(json.books.map((b) => [b.title, b]));
    assert.equal(byTitle.Present.filePresent, true);
    assert.equal(byTitle.Missing.filePresent, false);
    assert.deepEqual(json.allTags, []);
  });
});

test('local DELETE /api/library/:id: file inside DOWNLOAD_PATH is deleted and history rows dropped', async () => {
  const p = path.join(DL, 'Doomed [A].epub');
  fs.writeFileSync(p, 'bytes');
  const e = addDownload(p);
  history.add({ type: 'notify', downloadId: e.id, filename: e.filename, to: ['X'] });

  await withServer(app, async (port) => {
    const { status, json } = await request(port, 'DELETE', `/api/library/${e.id}`);
    assert.equal(status, 200);
    assert.deepEqual(json, { ok: true, fileDeleted: true });
  });
  assert.ok(!fs.existsSync(p), 'file removed from disk');
  assert.deepEqual(history.readAll(), [], 'download + correlated notify rows gone');
  assert.deepEqual(setTagsCalls, [[p, []]]);
});

test('local DELETE /api/library/:id: missing file → 200 with fileDeleted false', async () => {
  const p = path.join(DL, 'Already Gone [A].epub');
  const e = addDownload(p);
  await withServer(app, async (port) => {
    const { status, json } = await request(port, 'DELETE', `/api/library/${e.id}`);
    assert.equal(status, 200);
    assert.deepEqual(json, { ok: true, fileDeleted: false });
  });
  assert.deepEqual(history.readAll(), []);
  assert.deepEqual(setTagsCalls, [[p, []]]);
});

test('local DELETE /api/library/:id: a savePath OUTSIDE DOWNLOAD_PATH is never deleted', async () => {
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-libchar-outside-'));
  const p = path.join(outsideDir, 'Elsewhere.epub');
  fs.writeFileSync(p, 'bytes');
  const e = addDownload(p);
  await withServer(app, async (port) => {
    const { status, json } = await request(port, 'DELETE', `/api/library/${e.id}`);
    assert.equal(status, 200);
    assert.deepEqual(json, { ok: true, fileDeleted: false });
  });
  assert.ok(fs.existsSync(p), 'file outside the download root survives');
  assert.deepEqual(history.readAll(), [], 'history rows still cleared');
});

test('local DELETE /api/library/:id: unknown id → 404', async () => {
  await withServer(app, async (port) => {
    const { status } = await request(port, 'DELETE', '/api/library/nope');
    assert.equal(status, 404);
  });
  assert.deepEqual(setTagsCalls, []);
});

test('local PUT /api/library/:id/tags: setTags receives the entry savePath and the tags', async () => {
  const p = path.join(DL, 'Tagged [A].epub');
  const e = addDownload(p);
  await withServer(app, async (port) => {
    const { status, json } = await request(port, 'PUT', `/api/library/${e.id}/tags`, { tags: ['sci-fi', 'fave'] });
    assert.equal(status, 200);
    assert.deepEqual(json, { ok: true, tags: ['sci-fi', 'fave'] });
  });
  assert.deepEqual(setTagsCalls, [[p, ['sci-fi', 'fave']]]);
});

test('local PUT /api/library/:id/cover: sets the cover on every entry for that file, with NO file on disk', async () => {
  const p = path.join(DL, 'Covered [A].epub'); // never created — covers don't read the book
  const older = addDownload(p);
  const newer = addDownload(p);
  const other = addDownload(path.join(DL, 'Other.epub'));
  await withServer(app, async (port) => {
    const { status, json } = await request(port, 'PUT', `/api/library/${newer.id}/cover`, { cover: 'https://x/y.jpg' });
    assert.equal(status, 200);
    assert.deepEqual(json, { ok: true, cover: 'https://x/y.jpg' });
  });
  const byId = Object.fromEntries(history.readAll().map((e) => [e.id, e]));
  assert.equal(byId[older.id].cover, 'https://x/y.jpg');
  assert.equal(byId[newer.id].cover, 'https://x/y.jpg');
  assert.equal(byId[other.id].cover, undefined);
  assert.ok(!fs.existsSync(p));
});
