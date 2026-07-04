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

test('buildNewBooksEmail: escapes HTML in titles', () => {
  const msg = buildNewBooksEmail({ name: 'D', readerToken: 't2345678901234567890' },
    [{ title: 'Cat<script>x</script>', author: '' }]);
  assert.ok(!msg.html.includes('<script>x'));
});

test('buildInviteEmail: personal, carries the link, warns to keep it private', () => {
  const msg = buildInviteEmail({ name: 'April', readerToken: 'tok223456789012345678' });
  assert.match(msg.subject, /invited/i);
  assert.match(msg.text, /April/);
  assert.match(msg.text, /\/reader\?t=tok223456789012345678/);
  assert.match(msg.text, /keep the link to yourself/i);
});
