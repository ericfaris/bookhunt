'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  recentBooks,
  sentTo,
  buildNewBooksEmail,
  buildInviteEmail,
  newToken,
  readerLink,
} = require('../src/reader');

const NOW = Date.parse('2026-07-04T12:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 24 * 3600 * 1000).toISOString();

// --- recentBooks: what surfaces on a reader's shelf ---------------------------

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
