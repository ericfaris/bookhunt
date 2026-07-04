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

test('entryKey: case-insensitive identity', () => {
  const e = { title: 'Theo of Golden', author: 'Allen Levi' };
  assert.equal(entryKey(e), entryKey({ title: 'THEO OF GOLDEN', author: 'allen levi' }));
});

// The dedupe the radar lives on: the same book spelled differently across
// sources must resolve to one identity.
test('entryKey: cross-source spellings of the same book agree', () => {
  const nytStyle = { title: 'Whistler', author: 'Ann Patchett' };
  assert.equal(entryKey({ title: 'Whistler: A Novel', author: 'Ann Patchett' }), entryKey(nytStyle));
  assert.equal(entryKey({ title: 'Whistler (Deluxe Edition)', author: 'Patchett, Ann' }), entryKey(nytStyle));
  assert.equal(entryKey({ title: 'Whistler', author: 'Ann Patchett and Someone Else' }), entryKey(nytStyle));
  assert.notEqual(entryKey({ title: 'Whistler', author: 'Someone Different' }), entryKey(nytStyle));
});

test('entryKey: folds diacritics and punctuation', () => {
  assert.equal(
    entryKey({ title: 'Beartown!', author: 'Fredrik Backman' }),
    entryKey({ title: 'Beartöwn', author: 'fredrik BACKMAN' })
  );
});

// --- cleanTitle / authorLastName ---------------------------------------------

test('cleanTitle: strips subtitles and series parentheticals', () => {
  const { cleanTitle } = require('../src/lists');
  assert.equal(cleanTitle('The Calamity Club: A Novel'), 'The Calamity Club');
  assert.equal(cleanTitle('Tempting Venom: An Enemies to Lovers MM Hockey Romance (Vipers Book 3)'), 'Tempting Venom');
  assert.equal(cleanTitle('The Exquisite Torment of Loving Your Enemy (Dearly Beloathed, #2)'), 'The Exquisite Torment of Loving Your Enemy');
  assert.equal(cleanTitle('Whistler'), 'Whistler');
});

test('authorLastName: collaborations, suffixes, and Last-First order', () => {
  const { authorLastName } = require('../src/lists');
  assert.equal(authorLastName('Ann Patchett'), 'patchett');
  assert.equal(authorLastName('Patchett, Ann'), 'patchett');
  assert.equal(authorLastName('James Patterson and Bill Clinton'), 'patterson');
  assert.equal(authorLastName('Sammy Davis Jr.'), 'davis');
  assert.equal(authorLastName(''), '');
});

// --- source parsers (fixtures) --------------------------------------------------

test('amazon.parse: per-item scoping pairs titles with authors', () => {
  const { parse } = require('../src/listsources/amazon');
  const item = (i, title, author) =>
    `<div id="p13n-asin-index-${i}"><span class="_x_p13n-sc-css-line-clamp-1_y">${title}</span>` +
    (author ? `<span class="_x_p13n-sc-css-line-clamp-1_y">${author}</span>` : '') + '</div>';
  const html = item(0, 'The Calamity Club: A Novel', 'Kathryn Stockett') +
    item(1, 'Orphan Title', '') + // author missing must not shift later pairings
    item(2, 'Whistler: A Novel', 'Ann Patchett');
  const out = parse(html);
  assert.deepEqual(out, [
    { title: 'The Calamity Club', author: 'Kathryn Stockett' },
    { title: 'Orphan Title', author: '' },
    { title: 'Whistler', author: 'Ann Patchett' },
  ]);
});

test('amazon.parse: a bot page yields zero entries (fetch turns that into an error)', () => {
  const { parse } = require('../src/listsources/amazon');
  assert.deepEqual(parse('<html><body>Oops! Something went wrong.</body></html>'), []);
});

test('goodreads.parse: reads books + authors out of __NEXT_DATA__', () => {
  const { parse } = require('../src/listsources/goodreads');
  const apollo = {
    'Contributor:1': { name: 'Christina  Lauren' },
    'Book:11': { titleComplete: 'The Romance Revival', primaryContributorEdge: { node: { __ref: 'Contributor:1' } } },
    'Book:12': { titleComplete: 'Solo Story (Series, #2)' }, // no contributor
    'Query': {},
  };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { apolloState: apollo } } })}</script>`;
  assert.deepEqual(parse(html), [
    { title: 'The Romance Revival', author: 'Christina Lauren' },
    { title: 'Solo Story', author: '' },
  ]);
});

test('goodreads.parse: throws on a page without __NEXT_DATA__', () => {
  const { parse } = require('../src/listsources/goodreads');
  assert.throws(() => parse('<html>redesigned</html>'), /markup change/);
});

// --- state migration (v1 → v2) ---------------------------------------------------

test('migrateState: v1 key-array snapshots and seen map survive the key-scheme change', () => {
  const { migrateState } = require('../src/lists');
  const v1 = {
    snapshots: { 'hardcover-fiction': { pulledAt: 'T', keys: ['theo of golden|allen levi'] } },
    seen: { 'theo of golden|allen levi': { at: 'T', disposition: 'watching' } },
    pendingEvents: [],
    lastRunAt: 'T',
  };
  const v2 = migrateState(v1);
  assert.equal(v2.v, 2);
  const entries = v2.snapshots['hardcover-fiction'].entries;
  assert.deepEqual(entries, [{ title: 'theo of golden', author: 'allen levi' }]);
  // The migrated snapshot must key identically to a fresh pull of the same book,
  // or migration itself would flood the watchlist with "new" entrants.
  assert.equal(entryKey(entries[0]), entryKey({ title: 'Theo of Golden', author: 'Allen Levi' }));
  assert.ok(v2.seen[entryKey({ title: 'Theo of Golden', author: 'Allen Levi' })]);
  assert.equal(migrateState(v2), v2, 'already-migrated state passes through');
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
