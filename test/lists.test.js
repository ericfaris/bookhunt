'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  titleCase,
  normalizeEntry,
  entryKey,
  newEntrants,
  expiredListWatches,
} = require('../src/lists');
const { buildDigest } = require('../src/listwatcher');
const { clampListHours, MIN_LIST_HOURS, MAX_LIST_HOURS, DEFAULT_LIST_HOURS } = require('../src/settings');

// --- titleCase (NYT delivers ALL-CAPS titles) --------------------------------

test('titleCase: converts NYT all-caps to natural casing', () => {
  assert.equal(titleCase('THEO OF GOLDEN'), 'Theo of Golden');
  assert.equal(titleCase('TOMORROW, AND TOMORROW, AND TOMORROW'), 'Tomorrow, and Tomorrow, and Tomorrow');
});

test('titleCase: first and last words are always capitalized, even small words', () => {
  assert.equal(titleCase('THE DEAD ROMANTICS'), 'The Dead Romantics');
  assert.equal(titleCase('SOMETHING TO LIVE FOR'), 'Something to Live For');
});

test('titleCase: handles hyphens and apostrophes', () => {
  assert.equal(titleCase("THE HITCHHIKER'S GUIDE"), "The Hitchhiker's Guide");
  assert.equal(titleCase('MOTHER-DAUGHTER MURDER NIGHT'), 'Mother-Daughter Murder Night');
});

// --- normalizeEntry -----------------------------------------------------------

test('normalizeEntry: maps an NYT book row to {title, author}', () => {
  assert.deepEqual(
    normalizeEntry({ title: 'PROJECT HAIL MARY', author: 'Andy Weir', rank: 1 }),
    { title: 'Project Hail Mary', author: 'Andy Weir' }
  );
});

test('normalizeEntry: junk rows (no title) become null', () => {
  assert.equal(normalizeEntry({ author: 'Nobody' }), null);
  assert.equal(normalizeEntry(null), null);
});

// --- diff ----------------------------------------------------------------------

const week1 = [
  { title: 'Theo of Golden', author: 'Allen Levi' },
  { title: 'Whistler', author: 'Ann Patchett' },
];
const week2 = [
  { title: 'Theo of Golden', author: 'Allen Levi' },
  { title: 'Brand New Book', author: 'Fresh Author' },
];

test('newEntrants: only books absent from the previous snapshot', () => {
  const out = newEntrants(week1.map(entryKey), week2);
  assert.deepEqual(out, [{ title: 'Brand New Book', author: 'Fresh Author' }]);
});

test('newEntrants: unchanged list yields nothing', () => {
  assert.deepEqual(newEntrants(week1.map(entryKey), week1), []);
});

test('newEntrants: empty previous snapshot treats everything as new', () => {
  assert.equal(newEntrants([], week1).length, 2);
});

test('entryKey: case-insensitive identity, aligned with watchlist.queryKey', () => {
  const { queryKey } = require('../src/watchlist');
  const e = { title: 'Theo of Golden', author: 'Allen Levi' };
  assert.equal(entryKey(e), entryKey({ title: 'THEO OF GOLDEN', author: 'allen levi' }));
  assert.equal(entryKey(e), queryKey(e));
});

// --- expiry ---------------------------------------------------------------------

test('expiredListWatches: only ACTIVE list-origin watches past max age', () => {
  const now = Date.parse('2026-07-04T00:00:00Z');
  const old = new Date(now - 60 * 24 * 3600 * 1000).toISOString(); // 60 days
  const fresh = new Date(now - 5 * 24 * 3600 * 1000).toISOString();
  const watches = [
    { id: 'a', status: 'active', source: 'list', createdAt: old },
    { id: 'b', status: 'active', source: 'list', createdAt: fresh },
    { id: 'c', status: 'fulfilled', source: 'list', createdAt: old },
    { id: 'd', status: 'active', createdAt: old }, // hand-added — never expires
  ];
  assert.deepEqual(expiredListWatches(watches, now).map((w) => w.id), ['a']);
});

// --- digest ---------------------------------------------------------------------

test('buildDigest: null when there is nothing to say (quiet week = no email)', () => {
  assert.equal(buildDigest([]), null);
  assert.equal(buildDigest(null), null);
});

test('buildDigest: sections and counts reflect the events', () => {
  const msg = buildDigest([
    { type: 'added', title: 'Theo of Golden', author: 'Allen Levi' },
    { type: 'watching', title: 'Brand New Book', author: 'Fresh Author', list: 'NYT Hardcover Fiction' },
    { type: 'unverified', title: 'Fuzzy File', author: '' },
    { type: 'expired', title: 'Never Showed', author: 'Ghost Writer' },
  ]);
  assert.match(msg.subject, /1 added/);
  assert.match(msg.subject, /1 now watched/);
  assert.match(msg.text, /Added to your Library[\s\S]*Theo of Golden — Allen Levi/);
  assert.match(msg.text, /Now watching[\s\S]*Brand New Book — Fresh Author \(NYT Hardcover Fiction\)/);
  assert.match(msg.text, /couldn.t verify[\s\S]*Fuzzy File/);
  assert.match(msg.text, /Stopped watching[\s\S]*Never Showed/);
  assert.match(msg.html, /<li>Theo of Golden — Allen Levi<\/li>/);
});

test('buildDigest: escapes HTML in titles', () => {
  const msg = buildDigest([{ type: 'added', title: 'Cat<script>alert(1)</script>', author: '' }]);
  assert.ok(!msg.html.includes('<script>'));
  assert.ok(msg.html.includes('&lt;script&gt;'));
});

// --- politeness floor for list-origin watches ------------------------------------

test('dueWatchesMixed: list watches respect the floor even on a tight user cadence', () => {
  const { dueWatchesMixed } = require('../src/watchlist');
  const now = Date.parse('2026-07-04T12:00:00Z');
  const twoHoursAgo = new Date(now - 2 * 3600 * 1000).toISOString();
  const twoDaysAgo = new Date(now - 48 * 3600 * 1000).toISOString();
  const watches = [
    { id: 'hand', status: 'active', lastCheckedAt: twoHoursAgo },
    { id: 'list-recent', status: 'active', source: 'list', lastCheckedAt: twoHoursAgo },
    { id: 'list-stale', status: 'active', source: 'list', lastCheckedAt: twoDaysAgo },
  ];
  // User cadence: 15 minutes. Hand watch is due; the recently-checked list
  // watch is NOT (24h floor); the stale list watch is.
  const due = dueWatchesMixed(watches, now, 15 * 60000, 24 * 3600 * 1000);
  assert.deepEqual(due.map((w) => w.id), ['list-stale', 'hand']);
});

test('dueWatchesMixed: a never-checked list watch is immediately due', () => {
  const { dueWatchesMixed } = require('../src/watchlist');
  const watches = [{ id: 'new', status: 'active', source: 'list', lastCheckedAt: null }];
  const due = dueWatchesMixed(watches, Date.now(), 15 * 60000, 24 * 3600 * 1000);
  assert.deepEqual(due.map((w) => w.id), ['new']);
});

// --- settings clamp ---------------------------------------------------------------

test('clampListHours: clamps to bounds and falls back on junk', () => {
  assert.equal(clampListHours(0), MIN_LIST_HOURS);
  assert.equal(clampListHours(10000), MAX_LIST_HOURS);
  assert.equal(clampListHours('nope'), DEFAULT_LIST_HOURS);
  assert.equal(clampListHours(24), 24);
});
