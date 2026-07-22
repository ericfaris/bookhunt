'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  recentBooks,
  sendableBooks,
  paginate,
  sentTo,
  buildNewBooksEmail,
  buildInviteEmail,
  newToken,
  readerLink,
  searchLibrary,
  fuzzyScore,
  planReaderWatch,
} = require('../src/reader');
const watchlist = require('../src/watchlist');

const NOW = Date.parse('2026-07-04T12:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 24 * 3600 * 1000).toISOString();

// --- recentBooks: what triggers the "new books" EMAIL digest ------------------

test('recentBooks: verified, on-disk, within the window only', () => {
  const books = [
    { id: 'a', verified: true, filePresent: true, acquiredAt: daysAgo(2) },
    { id: 'b', verified: false, filePresent: true, acquiredAt: daysAgo(2) },   // unverified
    { id: 'c', verified: true, filePresent: false, acquiredAt: daysAgo(2) },   // file gone
    { id: 'd', verified: true, filePresent: true, acquiredAt: daysAgo(45) },   // too old
    { id: 'e', verified: true, filePresent: true, acquiredAt: null },          // no date
  ];
  assert.deepEqual(recentBooks(books, NOW, 30).map((b) => b.id), ['a']);
});

// --- sendableBooks: the shelf page's full (unwindowed) source list ------------

test('sendableBooks: verified + on-disk only, no date window, order preserved', () => {
  const books = [
    { id: 'a', verified: true, filePresent: true, acquiredAt: daysAgo(2) },
    { id: 'b', verified: false, filePresent: true, acquiredAt: daysAgo(2) },   // unverified
    { id: 'c', verified: true, filePresent: false, acquiredAt: daysAgo(2) },   // file gone
    { id: 'd', verified: true, filePresent: true, acquiredAt: daysAgo(400) },  // old — still included
  ];
  assert.deepEqual(sendableBooks(books).map((b) => b.id), ['a', 'd'],
    'unlike recentBooks, an old-but-sendable book is included and nothing is time-windowed');
});

// --- paginate: the shelf's lazy-load slicing -----------------------------------

test('paginate: slices a page and reports hasMore', () => {
  const list = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(paginate(list, 0, 2), { slice: ['a', 'b'], total: 5, hasMore: true });
  assert.deepEqual(paginate(list, 2, 2), { slice: ['c', 'd'], total: 5, hasMore: true });
  assert.deepEqual(paginate(list, 4, 2), { slice: ['e'], total: 5, hasMore: false }, 'last partial page');
  assert.deepEqual(paginate(list, 5, 2), { slice: [], total: 5, hasMore: false }, 'past the end');
});

test('paginate: tolerates an empty/undefined list', () => {
  assert.deepEqual(paginate(undefined, 0, 10), { slice: [], total: 0, hasMore: false });
  assert.deepEqual(paginate([], 0, 10), { slice: [], total: 0, hasMore: false });
});

// --- sentTo: the "✓ On your Kindle" state --------------------------------------

test('sentTo: matches the app’s to-as-names convention, case-insensitively', () => {
  const book = { sends: [{ to: ['Darla'] }, { to: ['April', 'Eric'] }] };
  assert.equal(sentTo(book, { name: 'darla' }), true);
  assert.equal(sentTo(book, { name: 'April' }), true);
  assert.equal(sentTo(book, { name: 'Nobody' }), false);
  assert.equal(sentTo({ sends: [] }, { name: 'Darla' }), false);
});

// --- send throttle (leaked-link blast-radius bound) --------------------------------

test('sendAllowed: caps sends per reader per window, recovers after it', () => {
  const { sendAllowed } = require('../src/reader');
  const log = new Map();
  const t0 = Date.parse('2026-07-04T12:00:00Z');
  for (let i = 0; i < 15; i++) {
    assert.equal(sendAllowed('darla', t0 + i * 1000, log), true, `send ${i + 1} allowed`);
  }
  assert.equal(sendAllowed('darla', t0 + 16000, log), false, '16th send throttled');
  assert.equal(sendAllowed('april', t0 + 16000, log), true, 'other readers unaffected');
  assert.equal(sendAllowed('darla', t0 + 3700000, log), true, 'window expiry frees the reader');
});

// --- tokens & links --------------------------------------------------------------

test('newToken: long, urlsafe, unique', () => {
  const a = newToken();
  const b = newToken();
  assert.ok(a.length >= 40);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(a, b);
});

test('readerLink: token rides the query string', () => {
  const link = readerLink({ readerToken: 'abc_123' });
  assert.match(link, /\/reader\?t=abc_123$/);
});

// --- emails -----------------------------------------------------------------------

test('buildNewBooksEmail: lists the books and carries the magic link', () => {
  const r = { name: 'Darla', readerToken: 'tok123456789012345678' };
  const msg = buildNewBooksEmail(r, [
    { title: 'Theo of Golden', author: 'Allen Levi', cover: 'https://x/c.jpg' },
    { title: 'Whistler', author: 'Ann Patchett', cover: null },
  ]);
  assert.match(msg.subject, /2 new books/);
  assert.match(msg.text, /Theo of Golden — Allen Levi/);
  assert.match(msg.text, /\/reader\?t=tok123456789012345678/);
  assert.match(msg.html, /Whistler/);
  assert.match(msg.html, /unsub=1/, 'has a stop-emails link');
});

test('buildNewBooksEmail: carries the brand shell (wordmark + signature)', () => {
  const msg = buildNewBooksEmail({ name: 'Darla', readerToken: 'tok123456789012345678' },
    [{ title: 'Theo of Golden', author: 'Allen Levi', cover: null }]);
  assert.match(msg.html, /Book<span[^>]*>Hunt<\/span>/, 'has the BookHunt wordmark');
  assert.match(msg.html, /Sent with ♥ by Eric/, 'has the app signature footer');
  assert.match(msg.html, /#1c2a56/, 'uses the navy brand color');
});

test('buildNewBooksEmail: cover URLs become inline CID attachments', () => {
  const msg = buildNewBooksEmail({ name: 'D', readerToken: 't2345678901234567890' }, [
    { title: 'With Cover', author: 'A', cover: 'https://x/c.jpg' },
    { title: 'No Cover', author: 'B', cover: null },
  ]);
  assert.equal(msg.attachments.length, 1, 'only the book with a cover attaches');
  assert.equal(msg.attachments[0].cid, 'cover0@book');
  assert.equal(msg.attachments[0].path, 'https://x/c.jpg');
  assert.match(msg.html, /cid:cover0@book/, 'html references the CID');
  assert.match(msg.html, /📖/, 'the cover-less book gets a placeholder');
});

test('buildNewBooksEmail: escapes HTML in titles', () => {
  const msg = buildNewBooksEmail({ name: 'D', readerToken: 't2345678901234567890' },
    [{ title: 'Cat<script>x</script>', author: '' }]);
  assert.ok(!msg.html.includes('<script>x'));
});

test('buildInviteEmail: personal, carries the link, uses the brand shell', () => {
  const msg = buildInviteEmail({ name: 'April Faris', readerToken: 'tok223456789012345678' });
  assert.match(msg.subject, /April/, 'greets by first name');
  assert.match(msg.text, /April/);
  assert.match(msg.text, /\/reader\?t=tok223456789012345678/);
  assert.match(msg.html, /Book<span[^>]*>Hunt<\/span>/, 'has the wordmark');
  assert.match(msg.html, /Open my shelf/, 'has the CTA button');
  assert.match(msg.html, /just for you/i, 'reassures the link is private, plainly');
  assert.deepEqual(msg.attachments, [], 'invite has no attachments');
});

// --- searchLibrary: reader-facing whole-library search -------------------------

test('searchLibrary: sendable-only, title and author matching, deduped', () => {
  const books = [
    { id: 'a', title: 'Theo of Golden', author: 'Allen Levi', verified: true, filePresent: true },
    { id: 'b', title: 'Theo of Golden', author: 'Allen Levi', verified: false, filePresent: true },  // unverified
    { id: 'c', title: 'Theo of Golden', author: 'Allen Levi', verified: true, filePresent: false },  // file gone
    { id: 'd', title: 'Whistler', author: 'Ann Patchett', verified: true, filePresent: true },
  ];
  assert.deepEqual(searchLibrary(books, 'Theo of Golden').map((b) => b.id), ['a'],
    'only the verified, on-disk match surfaces');
  assert.deepEqual(searchLibrary(books, 'Allen Levi').map((b) => b.id), ['a'],
    'author-name query matches too');
  assert.deepEqual(searchLibrary(books, ''), [], 'blank query returns nothing');
  assert.deepEqual(searchLibrary(books, '   '), [], 'whitespace-only query returns nothing');
});

test('searchLibrary: a book matching both title and author appears once', () => {
  const books = [{ id: 'a', title: 'Theo of Golden', author: 'Allen Levi', verified: true, filePresent: true }];
  assert.deepEqual(searchLibrary(books, 'Theo of Golden').map((b) => b.id), ['a']);
});

test('searchLibrary: fuzzy — a partial word mid-typed still finds the book', () => {
  const books = [{ id: 'a', title: 'The Burning Side', author: 'Sarah Damoff', verified: true, filePresent: true }];
  assert.deepEqual(searchLibrary(books, 'Burning').map((b) => b.id), ['a'],
    'a substring of the title matches while the reader is still typing');
});

test('searchLibrary: fuzzy — tolerates a typo', () => {
  const books = [{ id: 'a', title: 'The Whistler', author: 'John Grisham', verified: true, filePresent: true }];
  assert.deepEqual(searchLibrary(books, 'Wistler').map((b) => b.id), ['a'], 'one-letter typo still matches');
  assert.deepEqual(searchLibrary(books, 'Grisham').map((b) => b.id), ['a'], 'exact author still matches');
});

test('searchLibrary: fuzzy results rank best match first', () => {
  const books = [
    { id: 'close', title: 'Theo of Golding', author: 'A', verified: true, filePresent: true }, // near-typo
    { id: 'exact', title: 'Theo of Golden', author: 'B', verified: true, filePresent: true },
  ];
  assert.deepEqual(searchLibrary(books, 'Theo of Golden').map((b) => b.id), ['exact', 'close'],
    'the exact title outranks a merely similar (typo-d) one');
});

test('searchLibrary: unrelated titles are not returned', () => {
  const books = [{ id: 'a', title: 'A Court of Thorns and Roses', author: 'Sarah J. Maas', verified: true, filePresent: true }];
  assert.deepEqual(searchLibrary(books, 'zzz nonexistent qqq'), [], 'gibberish finds nothing');
});

// --- fuzzyScore: the underlying per-field matcher ------------------------------

test('fuzzyScore: substring match scores highest', () => {
  assert.equal(fuzzyScore('burning', 'The Burning Side'), 1);
});

test('fuzzyScore: blank query or field scores 0', () => {
  assert.equal(fuzzyScore('', 'The Burning Side'), 0);
  assert.equal(fuzzyScore('burning', ''), 0);
});

// --- planReaderWatch: the non-obvious merge-vs-create decision -----------------

test('planReaderWatch: no existing active watch → create', () => {
  const cleaned = watchlist.cleanWatchInput({ title: 'Theo of Golden', author: 'Allen Levi', recipientIds: ['r1'] });
  const plan = planReaderWatch([], cleaned, 'r1');
  assert.deepEqual(plan, { action: 'create', input: cleaned });
});

test('planReaderWatch: existing ACTIVE watch for the same query → merge recipient in', () => {
  const cleaned = watchlist.cleanWatchInput({ title: 'Theo of Golden', author: 'Allen Levi', recipientIds: ['r1'] });
  const watches = [{ id: 'w1', status: 'active', title: 'Theo of Golden', author: 'Allen Levi', recipientIds: ['op'] }];
  const plan = planReaderWatch(watches, cleaned, 'r1');
  assert.deepEqual(plan, { action: 'merge', id: 'w1', recipientIds: ['op', 'r1'] });
});

test('planReaderWatch: a paused/fulfilled watch for the same query does NOT merge', () => {
  const cleaned = watchlist.cleanWatchInput({ title: 'Theo of Golden', author: 'Allen Levi', recipientIds: ['r1'] });
  for (const status of ['paused', 'fulfilled']) {
    const watches = [{ id: 'w1', status, title: 'Theo of Golden', author: 'Allen Levi', recipientIds: ['op'] }];
    const plan = planReaderWatch(watches, cleaned, 'r1');
    assert.deepEqual(plan, { action: 'create', input: cleaned }, `${status} watch is ignored`);
  }
});

test('buildManifest: bakes the token into start_url for a per-reader home icon', () => {
  const { buildManifest } = require('../src/reader');
  const m = buildManifest('tok_abc123');
  assert.equal(m.name, 'BookHunt');
  assert.equal(m.short_name, 'BookHunt');
  assert.equal(m.start_url, '/reader?t=tok_abc123');
  assert.equal(m.scope, '/reader');
  assert.equal(m.display, 'standalone');
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'), 'has a maskable icon');
});
