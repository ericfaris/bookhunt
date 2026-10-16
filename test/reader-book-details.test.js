'use strict';

// Tap-a-book details modal on the reader shelf: the /reader/api/book route,
// reader.bookDetailsForReader, the large-cover URL upgrade, and the static
// wiring (dialog markup + one-time spotlight) in the reader page. Stores point
// at temp files and CF Access is disabled BEFORE requiring the app.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-reader-details-'));
process.env.HISTORY_FILE = path.join(TMP, 'history.json');
process.env.RECIPIENTS_FILE = path.join(TMP, 'recipients.json');
process.env.WATCHLIST_FILE = path.join(TMP, 'watchlist.json');
process.env.CF_ACCESS_TEAM_DOMAIN = '';
process.env.CF_ACCESS_AUD = '';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const history = require('../src/history');
const covers = require('../src/covers');
const reader = require('../src/reader');
const { app } = require('../src/server');
const { request, withServer } = require('./http-helpers');

const TOKEN = 'tok_' + 'x'.repeat(40);
const RECIPIENT = { id: 'r1', name: 'Alice', readerToken: TOKEN };

let origResolveMeta;
let origResolveCover;
let metaCalls;
beforeEach(() => {
  fs.writeFileSync(process.env.HISTORY_FILE, '[]');
  fs.writeFileSync(process.env.RECIPIENTS_FILE, JSON.stringify([
    { id: 'r1', name: 'Alice', email: 'a@example.com', kindleEmail: 'a@kindle.com', readerToken: TOKEN, readerEnabled: true },
  ]));
  origResolveMeta = covers.resolveMeta;
  origResolveCover = covers.resolveCover;
  covers.resolveCover = async () => null; // toReaderTile's fallback — keep it offline
  metaCalls = [];
  // No network: every test sees this canned catalog answer unless it overrides.
  covers.resolveMeta = async (q) => {
    metaCalls.push(q);
    return { cover: 'https://covers.openlibrary.org/b/id/9-M.jpg', description: 'A sweeping tale.' };
  };
});
afterEach(() => {
  covers.resolveMeta = origResolveMeta;
  covers.resolveCover = origResolveCover;
});

function addBook({ title = 'Real Book', author = 'Someone', cover = 'https://covers.openlibrary.org/b/id/1-M.jpg', onDisk = true, verified = true } = {}) {
  const p = path.join(TMP, `${title}.epub`);
  if (onDisk) fs.writeFileSync(p, 'bytes');
  return history.add({ type: 'download', title, author, cover, savePath: p, filename: path.basename(p), mode: 'premium', verified });
}

// --- largeCoverUrl -----------------------------------------------------------

test('largeCoverUrl: upgrades Open Library -M/-S to -L', () => {
  assert.equal(reader.largeCoverUrl('https://covers.openlibrary.org/b/id/123-M.jpg'), 'https://covers.openlibrary.org/b/id/123-L.jpg');
  assert.equal(reader.largeCoverUrl('https://covers.openlibrary.org/b/id/123-S.jpg'), 'https://covers.openlibrary.org/b/id/123-L.jpg');
  assert.equal(reader.largeCoverUrl('https://covers.openlibrary.org/b/id/123-L.jpg'), 'https://covers.openlibrary.org/b/id/123-L.jpg');
});

test('largeCoverUrl: strips Amazon size tokens to the original upload', () => {
  assert.equal(
    reader.largeCoverUrl('https://m.media-amazon.com/images/I/81abcXYZ._SY300_.jpg'),
    'https://m.media-amazon.com/images/I/81abcXYZ.jpg'
  );
  assert.equal(
    reader.largeCoverUrl('https://images-na.ssl-images-amazon.com/images/I/51x._AC_UL320_SR214,320_.jpg'),
    'https://images-na.ssl-images-amazon.com/images/I/51x.jpg'
  );
});

test('largeCoverUrl: unknown hosts unchanged, empty → null', () => {
  const g = 'https://books.google.com/books/content?id=abc&printsec=frontcover&img=1&zoom=1';
  assert.equal(reader.largeCoverUrl(g), g);
  assert.equal(reader.largeCoverUrl(''), null);
  assert.equal(reader.largeCoverUrl(null), null);
});

// --- bookDetailsForReader ------------------------------------------------------

test('bookDetailsForReader: sendable book → tile fields + description + large cover', async () => {
  const e = addBook();
  const d = await reader.bookDetailsForReader(RECIPIENT, e.id);
  assert.equal(d.id, e.id);
  assert.equal(d.title, 'Real Book');
  assert.equal(d.author, 'Someone');
  // Covers are served (and stored) by our own endpoint, never hot-linked.
  assert.match(d.cover, new RegExp(`^/reader/cover\\?t=${TOKEN}&id=${encodeURIComponent(e.id)}&v=[0-9a-f]{8}$`));
  assert.equal(d.coverLarge, d.cover, 'the stored image is already the large rendition');
  assert.equal(d.description, 'A sweeping tale.');
  assert.equal(d.sent, false);
  assert.deepEqual(metaCalls, [{ title: 'Real Book', author: 'Someone' }]);
});

test('bookDetailsForReader: unknown, unverified, or missing-file books → null', async () => {
  const unverified = addBook({ title: 'Unverified', verified: false });
  const gone = addBook({ title: 'Gone', onDisk: false });
  assert.equal(await reader.bookDetailsForReader(RECIPIENT, 'nope'), null);
  assert.equal(await reader.bookDetailsForReader(RECIPIENT, unverified.id), null);
  assert.equal(await reader.bookDetailsForReader(RECIPIENT, gone.id), null);
  assert.equal(await reader.bookDetailsForReader(RECIPIENT, ''), null);
  assert.equal(await reader.bookDetailsForReader(RECIPIENT, undefined), null);
});

test('bookDetailsForReader: a catalog lookup failure still returns the book, just without a blurb', async () => {
  const e = addBook();
  const d = await reader.bookDetailsForReader(RECIPIENT, e.id, {
    resolveMeta: async () => { throw new Error('boom'); },
  });
  assert.equal(d.title, 'Real Book');
  assert.equal(d.description, '');
  assert.match(d.coverLarge, /^\/reader\/cover\?/);
});

test('bookDetailsForReader: the cover URL version changes when the stored cover does', async () => {
  const e1 = addBook({ title: 'One', cover: 'https://covers.openlibrary.org/b/id/1-M.jpg' });
  const e2 = addBook({ title: 'Two', cover: null });
  const d1 = await reader.bookDetailsForReader(RECIPIENT, e1.id);
  const d2 = await reader.bookDetailsForReader(RECIPIENT, e2.id);
  const v = (u) => new URL(u, 'http://x').searchParams.get('v');
  assert.notEqual(v(d1.cover), v(d2.cover));
});

// --- GET /reader/api/book ---------------------------------------------------------

test('GET /reader/api/book: valid token + id → 200 with details', async () => {
  const e = addBook();
  await withServer(app, async (port) => {
    const res = await request(port, 'GET', `/reader/api/book?t=${TOKEN}&id=${encodeURIComponent(e.id)}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.kindleSet, true);
    assert.equal(res.json.book.title, 'Real Book');
    assert.equal(res.json.book.description, 'A sweeping tale.');
    assert.match(res.json.book.coverLarge, /^\/reader\/cover\?t=/);
  });
});

test('GET /reader/api/book: bad token → 404, no lookup', async () => {
  const e = addBook();
  await withServer(app, async (port) => {
    const res = await request(port, 'GET', `/reader/api/book?t=bogus_${'y'.repeat(30)}&id=${encodeURIComponent(e.id)}`);
    assert.equal(res.status, 404);
  });
  assert.equal(metaCalls.length, 0);
});

test('GET /reader/api/book: unknown or unsendable id → 404 (cannot probe history)', async () => {
  const unverified = addBook({ title: 'Hidden', verified: false });
  await withServer(app, async (port) => {
    for (const id of ['nope', unverified.id, '']) {
      const res = await request(port, 'GET', `/reader/api/book?t=${TOKEN}&id=${encodeURIComponent(id)}`);
      assert.equal(res.status, 404, `id=${JSON.stringify(id)}`);
    }
  });
});

test('GET /reader/api/book: personal response is never cached', async () => {
  const e = addBook();
  await withServer(app, async (port) => {
    const http = require('node:http');
    const headers = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: `/reader/api/book?t=${TOKEN}&id=${encodeURIComponent(e.id)}` }, (res) => {
        res.resume();
        resolve(res.headers);
      }).on('error', reject);
    });
    assert.equal(headers['cache-control'], 'no-store');
  });
});

// --- Static wiring: modal markup + one-time announcement ---------------------------

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'reader.html'), 'utf8');
const js = fs.readFileSync(path.join(PUBLIC, 'reader.js'), 'utf8');

test('reader.html: has the details <dialog> with close button, title, description, send', () => {
  assert.match(html, /<dialog id="bookDialog"[^>]*aria-labelledby="bookTitle"/);
  for (const id of ['bookClose', 'bookCover', 'bookTitle', 'bookAuthor', 'bookDesc', 'bookSend', 'bookErr']) {
    assert.ok(html.includes(`id="${id}"`), `has #${id}`);
  }
  assert.match(html, /id="bookClose"[^>]*aria-label="Close"/);
  assert.ok(html.includes('::backdrop'), 'styles a dimmed backdrop');
});

test('reader.js: tiles open the modal; backdrop click + ✕ close it; Send does not open it', () => {
  assert.ok(js.includes('details.open(b, kindleSet, markSent, tile)'), 'tile click opens details');
  assert.ok(js.includes("if (e.target === dlg || e.target.classList.contains('card') || e.target.classList.contains('body')) close();"), 'click on empty space closes');
  assert.ok(js.includes("$('#bookClose').onclick = close"), '✕ closes');
  assert.ok(js.includes('e.stopPropagation()'), 'send button click does not bubble to the tile');
  assert.ok(js.includes("'/reader/api/book?t='"), 'fetches details from the reader API');
});

test('reader.js: announces the feature once via the reusable spotlight, keyed for this feature', () => {
  assert.match(js, /id: 'book-details-2026-10'/);
  assert.ok(js.includes('details.announce(grid)'), 'announcement anchored to the shelf grid');
  // The search announcement must keep its own key so it isn't re-shown/merged.
  assert.match(js, /id: 'shelf-search-2026-07'/);
});

// --- Announcement email ------------------------------------------------------------

const smtp = require('../src/smtp');
const recipientsStore = require('../src/recipients');

test('teaser: short text unchanged; long text cut on a word with an ellipsis', () => {
  assert.equal(reader.teaser('Short and sweet.'), 'Short and sweet.');
  const long = 'word '.repeat(100);
  const t = reader.teaser(long, 50);
  assert.ok(t.length <= 51);
  assert.ok(t.endsWith('word…'));
});

test('buildBookDetailsAnnouncement: featured book, try-it link, steps, unsubscribe, CID cover', () => {
  const r = { name: 'Darla Smith', readerToken: TOKEN };
  const msg = reader.buildBookDetailsAnnouncement(r, {
    title: 'The <Women>', author: 'Kristin Hannah', cover: 'https://covers.openlibrary.org/b/id/1-L.jpg', description: 'A sweeping tale.',
  });
  assert.match(msg.subject, /tap a book/i);
  assert.ok(msg.html.includes('Hi Darla,'), 'first name greeting');
  assert.ok(msg.html.includes(`/reader?t=${TOKEN}`), 'has the reader’s own shelf link');
  assert.ok(msg.html.includes('Try it in my Library'), 'clear CTA');
  assert.ok(msg.html.includes('The &lt;Women&gt;'), 'title escaped');
  assert.ok(!msg.html.includes('The <Women>'));
  assert.ok(msg.html.includes('A sweeping tale.'));
  assert.ok(msg.html.includes('cid:feature-cover@book'));
  assert.deepEqual(msg.attachments, [{ filename: 'cover.jpg', path: 'https://covers.openlibrary.org/b/id/1-L.jpg', cid: 'feature-cover@book' }]);
  assert.ok(msg.html.includes('&amp;unsub=1'), 'unsubscribe link');
  assert.ok(msg.text.includes(`/reader?t=${TOKEN}`), 'plain-text part has the link too');
});

test('buildBookDetailsAnnouncement: no sample → generic card, no attachments', () => {
  const msg = reader.buildBookDetailsAnnouncement({ name: 'Al', readerToken: TOKEN }, null);
  assert.deepEqual(msg.attachments, []);
  assert.ok(msg.html.includes('Your next great read'));
  assert.ok(!msg.html.includes('cid:'));
});

test('announcementTargets: needs token + email, skips unsubscribed and already-announced', () => {
  const id = reader.BOOK_DETAILS_ANNOUNCEMENT;
  const list = [
    { id: 'a', email: 'a@x', readerToken: 't' },
    { id: 'b', email: 'b@x' },                                           // never invited
    { id: 'c', readerToken: 't' },                                       // no email
    { id: 'd', email: 'd@x', readerToken: 't', readerEnabled: false },   // unsubscribed
    { id: 'e', email: 'e@x', readerToken: 't', readerAnnouncements: { [id]: '2026-10-15' } },
    { id: 'f', email: 'f@x', readerToken: 't', readerAnnouncements: { other: 'x' } },
  ];
  assert.deepEqual(reader.announcementTargets(list, id).map((r) => r.id), ['a', 'f']);
});

test('announceBookDetails: dry run sends and stamps nothing', async () => {
  const origT = smtp.getTransport;
  let sends = 0;
  smtp.getTransport = () => ({ sendMail: async () => { sends++; } });
  try {
    const out = await reader.announceBookDetails({ sample: null });
    assert.equal(out.dryRun, true);
    assert.deepEqual(out.targets.map((t) => t.id), ['r1']);
    assert.equal(sends, 0);
    assert.ok(!recipientsStore.readAll()[0].readerAnnouncements);
  } finally { smtp.getTransport = origT; }
});

test('announceBookDetails: --send emails each target once, stamps them, re-run is a no-op', async () => {
  const origT = smtp.getTransport;
  const origC = smtp.isConfigured;
  const mails = [];
  smtp.getTransport = () => ({ sendMail: async (m) => { mails.push(m); } });
  smtp.isConfigured = () => true;
  try {
    const out = await reader.announceBookDetails({ send: true, sample: null, now: Date.parse('2026-10-15T12:00:00Z') });
    assert.deepEqual(out.sent, ['a@example.com']);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'a@example.com');
    assert.equal(recipientsStore.readAll()[0].readerAnnouncements[reader.BOOK_DETAILS_ANNOUNCEMENT], '2026-10-15T12:00:00.000Z');
    const again = await reader.announceBookDetails({ send: true, sample: null });
    assert.deepEqual(again.targets, []);
    assert.equal(mails.length, 1, 'nobody is emailed twice');
  } finally { smtp.getTransport = origT; smtp.isConfigured = origC; }
});

test('announceBookDetails: a failed send is reported and NOT stamped (so a re-run retries it)', async () => {
  const origT = smtp.getTransport;
  const origC = smtp.isConfigured;
  smtp.getTransport = () => ({ sendMail: async () => { throw new Error('smtp down'); } });
  smtp.isConfigured = () => true;
  try {
    const out = await reader.announceBookDetails({ send: true, sample: null });
    assert.deepEqual(out.failed, [{ email: 'a@example.com', error: 'smtp down' }]);
    assert.ok(!recipientsStore.readAll()[0].readerAnnouncements);
  } finally { smtp.getTransport = origT; smtp.isConfigured = origC; }
});

test('pickAnnouncementSample: newest shelf book with cover + blurb, large cover URL', async () => {
  addBook({ title: 'Older' });
  addBook({ title: 'Newest No Blurb' });
  const out = await reader.pickAnnouncementSample({
    resolveMeta: async ({ title }) => ({ cover: null, description: title === 'Older' ? 'Great book.' : null }),
  });
  assert.deepEqual(out, { title: 'Older', author: 'Someone', cover: 'https://covers.openlibrary.org/b/id/1-L.jpg', description: 'Great book.' });
});

// --- Cache-busting: the page must reference the CURRENT script ----------------------
// Regression: Cloudflare rewrote /reader/app.js to max-age=14400, so phones ran
// the old script (no tap handler) against the new page and taps did nothing.

test('GET /reader: script URL carries a content hash of reader.js', async () => {
  const crypto = require('node:crypto');
  const v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC, 'reader.js'))).digest('hex').slice(0, 12);
  await withServer(app, async (port) => {
    const res = await request(port, 'GET', '/reader');
    assert.equal(res.status, 200);
    assert.ok(res.body.includes(`<script src="/reader/app.js?v=${v}"></script>`), 'versioned script tag');
    assert.ok(!res.body.includes('src="/reader/app.js"'), 'no unversioned script tag left');
    assert.ok(res.body.includes('id="bookDialog"'), 'still the full reader page');
    const js = await request(port, 'GET', `/reader/app.js?v=${v}`);
    assert.equal(js.status, 200);
    assert.ok(js.body.includes('setupBookDetails'), 'versioned URL serves the script');
  });
});

// --- Reader Library: mega view + "shelf" → "Library" rename (2026-10) ---------

test('reader mega view: full-screen see-through dialog with blurred backdrop and ‹ › stepping', () => {
  assert.match(html, /dialog\.book::backdrop \{[^}]*backdrop-filter: blur\(/);
  assert.match(html, /dialog\.book \{[^}]*background: transparent/);
  assert.ok(html.includes('id="bookPrev"') && html.includes('id="bookNext"'));
  assert.ok(js.includes("e.key === 'ArrowLeft'") && js.includes("e.key === 'ArrowRight'"));
  assert.ok(js.includes('if (!dlg.open) { dlg.showModal();'), 'stepping never re-calls showModal on an open dialog');
});

test('reader page says "Library", not "shelf", and uses the ribbon logo', () => {
  assert.ok(html.includes('<title>Your BookHunt Library</title>'));
  assert.ok(!/📚<\/div>/.test(html), 'emoji logo replaced');
  assert.ok(html.includes('M136 28H176V236L156 216L136 236Z'), 'ribbon mark');
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  const visible = (code.match(/'[^'\n]*'|`[^`]*`/g) || []).filter((str) => /shelf/i.test(str) && !/shelf-search-2026-07|shelfSentinel/.test(str));
  assert.deepEqual(visible, [], 'no user-facing "shelf" strings left');
});

test('reader emails say Library', () => {
  const r = { name: 'Darla', readerToken: TOKEN };
  for (const msg of [require('../src/reader').buildInviteEmail(r), require('../src/reader').buildNewBooksEmail(r, [{ title: 'X' }]), reader.buildBookDetailsAnnouncement(r, null)]) {
    assert.ok(!/shelf/i.test(msg.subject + msg.text + msg.html.replace(/reader\?t=[^"&]*/g, '')), msg.subject);
    assert.match(msg.subject + msg.html, /Library/);
  }
});
