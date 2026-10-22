'use strict';

// HTTP surface of the cover-image store: /cover-image/book/:id (Library),
// /cover-image/lookup (search results, watchlist), /reader/cover (shelf), and
// the Library payload's coverImage URLs. Catalog/network calls are stubbed on
// the covers module; images land in the test's COVER_IMAGE_DIR.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-cover-routes-'));
process.env.HISTORY_FILE = path.join(TMP, 'history.json');
process.env.RECIPIENTS_FILE = path.join(TMP, 'recipients.json');
process.env.WATCHLIST_FILE = path.join(TMP, 'watchlist.json');
process.env.CF_ACCESS_TEAM_DOMAIN = '';
process.env.CF_ACCESS_AUD = '';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const history = require('../src/history');
const covers = require('../src/covers');
const { app } = require('../src/server');
const { request, withServer } = require('./http-helpers');

const TOKEN = 'tok_' + 'c'.repeat(40);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 1)]);

let orig;
beforeEach(() => {
  fs.writeFileSync(process.env.HISTORY_FILE, '[]');
  fs.writeFileSync(process.env.RECIPIENTS_FILE, JSON.stringify([{ id: 'r1', name: 'R', email: 'r@x.com', readerToken: TOKEN }]));
  orig = { resolveCover: covers.resolveCover, fetchCoverImage: covers.fetchCoverImage };
  covers.resolveCover = async () => null;
  covers.fetchCoverImage = async () => null;
});
afterEach(() => Object.assign(covers, orig));

let n = 0;
function addBook({ title, author = 'Some Author', cover = null } = {}) {
  title = title || `Route Book ${++n} ${Date.now()}`; // unique → its own stored image
  const p = path.join(TMP, `${title}.epub`);
  fs.writeFileSync(p, 'not really an epub');
  return history.add({ type: 'download', title, author, cover, savePath: p, filename: path.basename(p), mode: 'premium', verified: true });
}

function getRaw(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('GET /api/library: every book carries a versioned coverImage URL', async () => {
  const e = addBook({ cover: 'https://x/c.jpg' });
  await withServer(app, async (port) => {
    const res = await request(port, 'GET', '/api/library');
    const b = res.json.books.find((x) => x.id === e.id);
    assert.match(b.coverImage, new RegExp(`^/cover-image/book/${e.id}\\?v=[0-9a-f]{8}$`));
  });
});

test('GET /cover-image/book/:id: real image from the stored URL, cached for a week', async () => {
  const e = addBook({ cover: 'https://x/c.jpg' });
  covers.fetchCoverImage = async () => JPEG;
  await withServer(app, async (port) => {
    const res = await getRaw(port, `/cover-image/book/${e.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/jpeg');
    assert.equal(res.headers['cache-control'], 'private, max-age=604800');
    assert.ok(res.body.equals(JPEG));
  });
});

test('GET /cover-image/book/:id: nothing found → generated SVG jacket (never blank), short cache, locked-down CSP', async () => {
  const e = addBook({ title: 'Nowhere Book Zz' });
  await withServer(app, async (port) => {
    const res = await getRaw(port, `/cover-image/book/${e.id}`);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^image\/svg\+xml/);
    assert.equal(res.headers['cache-control'], 'private, max-age=3600');
    assert.match(res.headers['content-security-policy'], /default-src 'none'/);
    assert.ok(res.body.toString().includes('Nowhere'));
  });
});

test('GET /cover-image/book/:id: unknown id → 404', async () => {
  await withServer(app, async (port) => {
    assert.equal((await getRaw(port, '/cover-image/book/nope')).status, 404);
  });
});

test('GET /cover-image/lookup: catalog cover by title/author; empty query → 400', async () => {
  covers.resolveCover = async ({ title }) => (title === 'Watched Thing' ? 'https://cat/c.jpg' : null);
  covers.fetchCoverImage = async (u) => (u.startsWith('https://cat/') ? JPEG : null);
  await withServer(app, async (port) => {
    const ok = await getRaw(port, '/cover-image/lookup?title=Watched%20Thing&author=Someone');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['content-type'], 'image/jpeg');
    assert.equal((await getRaw(port, '/cover-image/lookup')).status, 400);
  });
});

test('GET /cover-image/lookup: only https cover hints are fetched', async () => {
  const asked = [];
  covers.fetchCoverImage = async (u) => { asked.push(u); return null; };
  await withServer(app, async (port) => {
    await getRaw(port, '/cover-image/lookup?title=Hinty%20Q&cover=' + encodeURIComponent('http://169.254.169.254/latest'));
  });
  assert.ok(!asked.some((u) => u.includes('169.254')), 'non-https hint ignored');
});

test('GET /reader/cover: token-gated, shelf books only', async () => {
  const e = addBook();
  const hidden = history.add({ type: 'download', title: 'Unverified', author: 'A', savePath: path.join(TMP, 'u.epub'), filename: 'u.epub', verified: false });
  await withServer(app, async (port) => {
    assert.equal((await getRaw(port, `/reader/cover?t=${TOKEN}&id=${e.id}`)).status, 200);
    assert.equal((await getRaw(port, `/reader/cover?t=bad_${'z'.repeat(30)}&id=${e.id}`)).status, 404);
    assert.equal((await getRaw(port, `/reader/cover?t=${TOKEN}&id=${hidden.id}`)).status, 404);
  });
});

test('GET /reader/cover: a full shelf of covers does NOT trip the 40/min reader rate limit', async () => {
  const e = addBook();
  await withServer(app, async (port) => {
    let last;
    for (let i = 0; i < 60; i++) last = await getRaw(port, `/reader/cover?t=${TOKEN}&id=${e.id}&v=${i}`);
    assert.equal(last.status, 200);
  });
});

test('app.js: no cover <img> hot-links a catalog — every one goes through coverImg()', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const imgs = [...js.matchAll(/el\('img', \{ className: '([^']*)'/g)].map((m) => m[1]).filter((c) => /cover/.test(c));
  assert.deepEqual(imgs, [], `direct cover <img>s left: ${imgs.join(', ')}`);
  assert.ok(!js.includes('/api/cover?'), 'no client lookups of cover URLs');
  assert.ok(js.includes("className: 'lib-cover lib-cover-open', src: libraryCoverSrc(book)"), 'Library uses the stored image');
  assert.ok(js.includes('src: lookupCoverUrl(w.title, w.author)'), 'watchlist uses the stored lookup');
});
