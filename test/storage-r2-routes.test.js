'use strict';

// r2-mode route tests (issue #47, AC3 + AC4). The app runs against an r2
// driver backed by the in-memory fake S3 — NO book files exist on local disk
// here, so anything that still reads the disk would fail. Never the network,
// never R2_* from process.env.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-r2routes-'));
const DL = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-r2routes-dl-'));
process.env.DOWNLOAD_PATH = DL;
process.env.HISTORY_FILE = path.join(TMP, 'history.json');
process.env.RECIPIENTS_FILE = path.join(TMP, 'recipients.json');
process.env.WATCHLIST_FILE = path.join(TMP, 'watchlist.json');
process.env.CF_ACCESS_TEAM_DOMAIN = '';
process.env.CF_ACCESS_AUD = '';

const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');

const storage = require('../src/storage');
const { createFakeS3 } = require('./fake-s3');
const history = require('../src/history');
const booktags = require('../src/booktags');
const recipients = require('../src/recipients');
const kindle = require('../src/kindle');
const notify = require('../src/notify');
const covers = require('../src/covers');
const searcher = require('../src/searcher');
const reader = require('../src/reader');
const { app } = require('../src/server');
const { request, withServer } = require('./http-helpers');

const STAGING = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-r2routes-stage-'));
let fake;

function freshDriver() {
  fake = createFakeS3();
  storage._setDriver(storage.createR2Driver({ root: DL, bucket: 'bookhunt-test', client: fake, stagingRoot: STAGING }));
  return fake;
}

const sp = (name) => path.join(DL, name);
const bookCalls = () => fake.calls.filter((c) => c.op === 'HeadObjectCommand' || c.op === 'GetObjectCommand');

function addDownload(name, extra = {}) {
  return history.add({
    type: 'download', title: extra.title || name.replace(/\.epub$/, ''), author: 'A',
    cover: 'https://example.com/c.jpg', // keep reader tiles off the network
    savePath: sp(name), filename: name, mode: 'premium', verified: true, ...extra,
  });
}

let orig;
let setTagsCalls;
let pushes;
beforeEach(() => {
  fs.writeFileSync(process.env.HISTORY_FILE, '[]');
  freshDriver();
  orig = {
    readStore: booktags.readStore, setTags: booktags.setTags, byIds: recipients.byIds,
    push: kindle.pushToKindle, notify: notify.notify, resolveCover: covers.resolveCover,
    resolveMeta: covers.resolveMeta, lookupCover: covers.lookupCover, sessionStatus: searcher.sessionStatus,
  };
  setTagsCalls = [];
  pushes = [];
  booktags.readStore = () => ({});
  booktags.setTags = (p, tags) => { setTagsCalls.push([p, tags]); return tags; };
  recipients.byIds = () => [
    { id: 'r1', name: 'A', kindleEmail: 'a@kindle.com' },
    { id: 'r2', name: 'B', kindleEmail: 'b@kindle.com' },
  ];
  kindle.pushToKindle = async (args) => { pushes.push(args); };
  notify.notify = async () => [];
  covers.resolveCover = async () => null;
  covers.resolveMeta = async () => ({});
  covers.lookupCover = async () => { throw new Error('network not allowed in tests'); };
  searcher.sessionStatus = async () => ({ browser: false, ready: false, loggedIn: false, cfOk: false });
});
afterEach(() => {
  booktags.readStore = orig.readStore;
  booktags.setTags = orig.setTags;
  recipients.byIds = orig.byIds;
  kindle.pushToKindle = orig.push;
  notify.notify = orig.notify;
  covers.resolveCover = orig.resolveCover;
  covers.resolveMeta = orig.resolveMeta;
  covers.lookupCover = orig.lookupCover;
  searcher.sessionStatus = orig.sessionStatus;
});
after(() => storage._reset());

// --- AC4: one list per render, zero per-book HEAD/GET -----------------------------

test('r2 GET /api/library: first render = exactly 1 ListObjectsV2 and 0 HEAD/GET; second render = 0 calls', async () => {
  for (let i = 0; i < 50; i++) {
    const name = `Book ${String(i).padStart(2, '0')}.epub`;
    fake.seed(`books/${name}`, `bytes ${i}`);
    addDownload(name);
  }
  await withServer(app, async (port) => {
    const first = await request(port, 'GET', '/api/library');
    assert.equal(first.status, 200);
    assert.equal(first.json.books.length, 50);
    assert.ok(first.json.books.every((b) => b.filePresent === true));
    assert.equal(fake.callsOf('ListObjectsV2Command').length, 1);
    assert.equal(bookCalls().length, 0);
    assert.equal(fake.calls.length, 1);

    const second = await request(port, 'GET', '/api/library');
    assert.equal(second.status, 200);
    assert.equal(fake.calls.length, 1, 'second render makes no storage calls');

    addDownload('Not In Bucket.epub', { title: 'Missing One' });
    const third = await request(port, 'GET', '/api/library');
    const missing = third.json.books.find((b) => b.title === 'Missing One');
    assert.equal(missing.filePresent, false);
    assert.equal(fake.calls.length, 1);
  });
  assert.equal(fs.readdirSync(DL).length, 0, 'nothing on local disk');
});

// --- tags / cover ------------------------------------------------------------------

test('r2 PUT /api/library/:id/tags works (keyed by the logical savePath)', async () => {
  fake.seed('books/Tagged.epub', 'x');
  const e = addDownload('Tagged.epub');
  await withServer(app, async (port) => {
    const { status, json } = await request(port, 'PUT', `/api/library/${e.id}/tags`, { tags: ['a'] });
    assert.equal(status, 200);
    assert.deepEqual(json, { ok: true, tags: ['a'] });
  });
  assert.deepEqual(setTagsCalls, [[sp('Tagged.epub'), ['a']]]);
});

test('r2 PUT /api/library/:id/cover works and never reads the stored book', async () => {
  fake.seed('books/Covered.epub', 'x');
  const e = addDownload('Covered.epub');
  await withServer(app, async (port) => {
    const { status, json } = await request(port, 'PUT', `/api/library/${e.id}/cover`, { cover: 'https://x/new.jpg' });
    assert.equal(status, 200);
    assert.equal(json.cover, 'https://x/new.jpg');
  });
  assert.equal(history.readAll().find((x) => x.id === e.id).cover, 'https://x/new.jpg');
  assert.equal(bookCalls().length, 0);
});

// --- delete --------------------------------------------------------------------------

test('r2 DELETE /api/library/:id: removes the object and the history rows', async () => {
  fake.seed('books/Doomed.epub', 'x');
  const e = addDownload('Doomed.epub');
  await withServer(app, async (port) => {
    await request(port, 'GET', '/api/library'); // loads the index
    const { status, json } = await request(port, 'DELETE', `/api/library/${e.id}`);
    assert.equal(status, 200);
    assert.deepEqual(json, { ok: true, fileDeleted: true });
    assert.ok(!fake.objects.has('books/Doomed.epub'));
    assert.equal(fake.callsOf('DeleteObjectCommand').length, 1);
    assert.equal(fake.callsOf('DeleteObjectCommand')[0].input.Key, 'books/Doomed.epub');
    const lib = await request(port, 'GET', '/api/library');
    assert.equal(lib.json.books.length, 0);
  });
  assert.deepEqual(setTagsCalls, [[sp('Doomed.epub'), []]]);
});

test('r2 DELETE /api/library/:id: a missing object → fileDeleted false', async () => {
  const e = addDownload('Never Uploaded.epub');
  await withServer(app, async (port) => {
    await request(port, 'GET', '/api/library');
    const { status, json } = await request(port, 'DELETE', `/api/library/${e.id}`);
    assert.equal(status, 200);
    assert.deepEqual(json, { ok: true, fileDeleted: false });
  });
});

test('r2 DELETE /api/library/:id: an R2 delete error is logged, history still cleared', async () => {
  fake.seed('books/Sticky.epub', 'x');
  const e = addDownload('Sticky.epub');
  await withServer(app, async (port) => {
    await request(port, 'GET', '/api/library');
    fake.failNext('DeleteObjectCommand', new Error('r2 down'));
    const { status, json } = await request(port, 'DELETE', `/api/library/${e.id}`);
    assert.equal(status, 200);
    assert.deepEqual(json, { ok: true, fileDeleted: false });
  });
  assert.deepEqual(history.readAll(), []);
});

// --- send (server) ---------------------------------------------------------------

test('r2 POST /api/send: attaches the object bytes (no filePath), ONE GetObject for two recipients', async () => {
  const bytes = Buffer.from('the real epub bytes');
  fake.seed('books/Send Me.epub', bytes);
  const e = addDownload('Send Me.epub');
  await withServer(app, async (port) => {
    const { status, json } = await request(port, 'POST', '/api/send', { downloadId: e.id, recipientIds: ['r1', 'r2'] });
    assert.equal(status, 200);
    assert.deepEqual(json.results.map((r) => r.kindle), [{ ok: true }, { ok: true }]);
  });
  assert.equal(pushes.length, 2);
  for (const p of pushes) {
    assert.deepEqual(Object.keys(p).sort(), ['content', 'filename', 'kindleEmail']);
    assert.deepEqual(p.content, bytes);
    assert.equal(p.filename, 'Send Me.epub');
  }
  assert.deepEqual(pushes.map((p) => p.kindleEmail), ['a@kindle.com', 'b@kindle.com']);
  assert.equal(fake.callsOf('GetObjectCommand').length, 1);
});

test('r2 POST /api/send: object not in the bucket → 410', async () => {
  const e = addDownload('Gone.epub');
  await withServer(app, async (port) => {
    const { status, json } = await request(port, 'POST', '/api/send', { downloadId: e.id, recipientIds: ['r1'] });
    assert.equal(status, 410);
    assert.equal(json.error, 'File no longer exists on disk.');
  });
  assert.equal(pushes.length, 0);
});

test('r2 POST /api/send: a GetObject failure becomes a per-recipient Kindle error, not a 500', async () => {
  fake.seed('books/Flaky.epub', 'x');
  const e = addDownload('Flaky.epub');
  await withServer(app, async (port) => {
    await request(port, 'GET', '/api/library');
    fake.failNext('GetObjectCommand', new Error('r2 timeout'));
    const { status, json } = await request(port, 'POST', '/api/send', { downloadId: e.id, recipientIds: ['r1', 'r2'] });
    assert.equal(status, 200);
    assert.deepEqual(json.results.map((r) => r.kindle), [{ ok: false, error: 'r2 timeout' }, { ok: false, error: 'r2 timeout' }]);
  });
  assert.equal(pushes.length, 0);
  assert.equal(fake.callsOf('GetObjectCommand').length, 1, 'not retried per recipient');
});

// --- reader portal ----------------------------------------------------------------

test('r2 reader.sendToReader: pushes the object bytes', async () => {
  const bytes = Buffer.from('reader bytes');
  fake.seed('books/Reader.epub', bytes);
  const e = addDownload('Reader.epub', { title: 'Reader Book' });
  const out = await reader.sendToReader({ id: 'r2-reader-1', name: 'R', kindleEmail: 'r@kindle.com' }, e.id);
  assert.equal(out.title, 'Reader Book');
  assert.equal(pushes.length, 1);
  assert.deepStrictEqual(pushes[0], { kindleEmail: 'r@kindle.com', filename: 'Reader.epub', content: bytes });
});

test('r2 reader.sendToReader: object deleted behind the index\'s back → "gone"', async () => {
  fake.seed('books/Vanished.epub', 'x');
  const e = addDownload('Vanished.epub');
  await storage.get().ensureIndex();
  fake.objects.delete('books/Vanished.epub'); // index still says present
  await assert.rejects(
    () => reader.sendToReader({ id: 'r2-reader-2', name: 'R', kindleEmail: 'r@kindle.com' }, e.id),
    (err) => err.code === 'gone'
  );
  assert.equal(pushes.length, 0);
});

test('r2 reader.sendToReader: object not indexed → "gone" without a GetObject', async () => {
  const e = addDownload('Never.epub');
  await assert.rejects(
    () => reader.sendToReader({ id: 'r2-reader-3', name: 'R', kindleEmail: 'r@kindle.com' }, e.id),
    (err) => err.code === 'gone'
  );
  assert.equal(fake.callsOf('GetObjectCommand').length, 0);
});

test('r2 reader.booksForReaderPage: loads the index once and offers present books as sendable', async () => {
  fake.seed('books/Shelf.epub', 'x');
  addDownload('Shelf.epub', { title: 'Shelf Book' });
  addDownload('Not Here.epub', { title: 'Ghost Book' });
  const { books } = await reader.booksForReaderPage({ id: 'r2-reader-4', name: 'R' }, 0, 10);
  assert.ok(books.some((b) => b.title === 'Shelf Book'));
  assert.ok(!books.some((b) => b.title === 'Ghost Book'));
  assert.equal(fake.callsOf('ListObjectsV2Command').length, 1);
  assert.equal(bookCalls().length, 0);
  const hits = await reader.searchForReader({ id: 'r2-reader-4', name: 'R' }, 'Shelf Book');
  assert.ok(hits.some((b) => b.title === 'Shelf Book'));
  assert.equal(fake.callsOf('ListObjectsV2Command').length, 1, 'index reused');
});

// --- watcher -------------------------------------------------------------------------

test('r2 watcher autoDeliver: pushes the object bytes for a verified download', async () => {
  const watcher = require('../src/watcher');
  const downloader = require('../src/downloader');
  const watchlist = require('../src/watchlist');
  const lists = require('../src/lists');
  const listwatcher = require('../src/listwatcher');
  const bytes = Buffer.from('watched bytes');
  fake.seed('books/Dune.epub', bytes);
  const stubs = [
    [searcher, 'search', async () => ({ results: [{ title: 'Dune', author: 'Herbert', url: 'https://forum.mobilism.org/t1', premium: true }] })],
    [watchlist, 'update', () => {}],
    [watchlist, 'remove', () => true],
    [notify, 'notify', async () => [{ channel: 'email', ok: true }]],
    [recipients, 'byIds', () => [{ id: 'r1', name: 'Sam', email: 'sam@example.com', kindleEmail: 'sam@kindle.com' }]],
    [history, 'logDownload', () => ({ id: 'd1' })],
    [history, 'logNotify', () => ({ id: 'n1' })],
    [downloader, 'hasPremiumCreds', () => true],
    [downloader, 'premiumDownload', async () => ({
      downloads: [{ filename: 'Dune.epub', savePath: sp('Dune.epub'), verified: true, size: bytes.length, titleMatch: true }],
      errors: [],
    })],
    [lists, 'recordEvent', () => {}],
    [listwatcher, 'scheduleDigestSoon', () => {}],
  ];
  const saved = stubs.map(([o, k]) => [o, k, o[k]]);
  for (const [o, k, fn] of stubs) o[k] = fn;
  const prevAlert = process.env.WATCH_ALERT_EMAIL;
  process.env.WATCH_ALERT_EMAIL = 'op@example.com';
  try {
    const out = await watcher.checkWatch({ id: 'w1', title: 'Dune', author: 'Herbert', sort: 'newest', recipientIds: ['r1'], checkCount: 0 });
    assert.equal(out.delivery.kindlePushed, 1);
  } finally {
    for (const [o, k, fn] of saved) o[k] = fn;
    if (prevAlert === undefined) delete process.env.WATCH_ALERT_EMAIL;
    else process.env.WATCH_ALERT_EMAIL = prevAlert;
  }
  assert.equal(pushes.length, 1);
  assert.deepStrictEqual(pushes[0], { kindleEmail: 'sam@kindle.com', filename: 'Dune.epub', content: bytes });
});

// --- status / healthz ----------------------------------------------------------------

test('r2 GET /api/status: reports the bucket, epub-only counts, disk null and healthy storage', async () => {
  fake.seed('books/One.epub', Buffer.alloc(100));
  fake.seed('books/Two.epub', Buffer.alloc(250));
  fake.seed('books/Notes.pdf', Buffer.alloc(999));
  await withServer(app, async (port) => {
    const { status, json } = await request(port, 'GET', '/api/status');
    assert.equal(status, 200);
    const d = json.download;
    assert.equal(d.path, 'r2://bookhunt-test/books/');
    assert.equal(d.exists, true);
    assert.equal(d.count, 2);
    assert.equal(d.totalBytes, 350);
    assert.equal(d.disk, null);
    assert.equal(d.storage.mode, 'r2');
    assert.equal(d.storage.bucket, 'bookhunt-test');
    assert.equal(d.storage.ok, true);
    assert.equal(d.storage.indexLoaded, true);
    assert.equal(d.storage.objectCount, 3);
    assert.equal(d.storage.lastError, null);
    assert.ok(!JSON.stringify(json).includes('cloudflarestorage'), 'no endpoint leaked');
  });
});

test('r2 GET /api/status: an unreachable bucket reports ok=false with lastError (still 200)', async () => {
  fake.failNext('ListObjectsV2Command', new Error('getaddrinfo ENOTFOUND'));
  await withServer(app, async (port) => {
    const { status, json } = await request(port, 'GET', '/api/status');
    assert.equal(status, 200);
    assert.equal(json.download.storage.ok, false);
    assert.equal(json.download.storage.lastError, 'getaddrinfo ENOTFOUND');
    assert.equal(json.download.exists, false);
    assert.equal(json.download.count, 0);
  });
});

test('r2 GET /healthz: 200 with storage block; STILL 200 when the index failed to load', async () => {
  await withServer(app, async (port) => {
    await storage.get().refresh();
    let r = await request(port, 'GET', '/healthz');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.storage.mode, 'r2');
    assert.equal(r.json.storage.ok, true);
    assert.equal(r.json.storage.indexLoaded, true);
    assert.deepEqual(Object.keys(r.json.storage).sort(), ['indexLoaded', 'lastRefreshAt', 'mode', 'ok']);

    freshDriver();
    fake.failNext('ListObjectsV2Command', new Error('down'));
    await storage.get().refresh().catch(() => {});
    r = await request(port, 'GET', '/healthz');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.storage.ok, false);
    assert.equal(r.json.storage.indexLoaded, false);
  });
});
