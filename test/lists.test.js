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

// A tooltip's escaped-HTML argument, in the exact `\"`/`\/`/`\n` escaped form
// the live Goodreads page emits inside new Tip($('bookCover…'), "…"). String.raw
// keeps the backslashes literal so the fixture mirrors real page bytes rather
// than a hand-unescaped paraphrase.
function tipBlock(cover, inner) {
  return `new Tip($('bookCover${cover}'), "${inner}", { hook: { target: 'topleft' }, className: 'coverTip' });`;
}

test('goodreads.parse: extracts title/author from Tip tooltip blocks', () => {
  const { parse } = require('../src/listsources/goodreads');
  const html =
    // normal entry
    tipBlock('1_11', String.raw`\n  <h2><a class=\"readable bookTitle\" href=\"https:\/\/www.goodreads.com\/book\/show\/1-the-divorce\">The Divorce<\/a><\/h2>\n  <div>\n    by <a class=\"authorName\" href=\"\/author\/show\/7.Freida_McFadden\">Freida McFadden<\/a><span title=\"Goodreads Author!\">*<\/span>\n  <\/div>`) +
    '\n' +
    // author padded with internal whitespace runs — cleanAuthor must collapse them
    tipBlock('2_22', String.raw`\n  <h2><a class=\"readable bookTitle\" href=\"\/book\/show\/2-the-berry-pickers\">The Berry Pickers<\/a><\/h2>\n  <div>\n    by <a class=\"authorName\" href=\"\/author\/show\/29.Amanda_Peters\">Amanda    Peters<\/a>\n  <\/div>`) +
    '\n' +
    // HTML entity + escaped quote in the title, plus a subtitle after ':' —
    // exercises the escape-aware capture (a naive "([^"]*)" would truncate at \")
    // and the decodeEntities → cleanTitle pipeline (subtitle stripped).
    tipBlock('3_33', String.raw`\n  <h2><a class=\"readable bookTitle\" href=\"\/book\/show\/3-grand-estate\">The \"Grand\" Estate &amp; Garden: A Novel<\/a><\/h2>\n  <div>\n    by <a class=\"authorName\" href=\"\/author\/show\/5.Emily_Henry\">Emily Henry<\/a>\n  <\/div>`);
  assert.deepEqual(parse(html), [
    { title: 'The Divorce', author: 'Freida McFadden' },
    { title: 'The Berry Pickers', author: 'Amanda Peters' },
    { title: 'The "Grand" Estate & Garden', author: 'Emily Henry' },
  ]);
});

test('goodreads.parse: multi-author byline takes the first authorName anchor', () => {
  const { parse } = require('../src/listsources/goodreads');
  const html = tipBlock('4_44', String.raw`\n  <h2><a class=\"readable bookTitle\" href=\"\/book\/show\/4-co\">Co Authored<\/a><\/h2>\n  <div>\n    by <a class=\"authorName\" href=\"\/author\/show\/1.James_Patterson\">James Patterson<\/a>, <a class=\"authorName\" href=\"\/author\/show\/2.Bill_Clinton\">Bill Clinton<\/a>\n  <\/div>`);
  assert.deepEqual(parse(html), [{ title: 'Co Authored', author: 'James Patterson' }]);
});

test('goodreads.parse: a page with no Tip blocks yields zero entries (fetch turns that into an error)', () => {
  const { parse } = require('../src/listsources/goodreads');
  assert.deepEqual(parse('<html><body>bot check</body></html>'), []);
});

test('goodreads.fetchGenrePage: rejects on non-OK and on 0-book parse, resolves on a valid body', async () => {
  const goodreads = require('../src/listsources/goodreads');
  const savedFetch = global.fetch;
  const validBody = tipBlock('9_99', String.raw`<h2><a class=\"readable bookTitle\" href=\"\/book\/show\/9-x\">Real Book<\/a><\/h2><div>by <a class=\"authorName\" href=\"\/author\/show\/9.A_Author\">A Author<\/a><\/div>`);
  try {
    global.fetch = async () => ({ ok: false, status: 503, text: async () => '' });
    await assert.rejects(goodreads.sources()[0].fetch(), /responded 503/);

    global.fetch = async () => ({ ok: true, status: 200, text: async () => '<html>no tips here</html>' });
    await assert.rejects(goodreads.sources()[0].fetch(), /parsed to 0 books/);

    global.fetch = async () => ({ ok: true, status: 200, text: async () => validBody });
    assert.deepEqual(await goodreads.sources()[0].fetch(), [{ title: 'Real Book', author: 'A Author' }]);
  } finally {
    global.fetch = savedFetch;
  }
});

test('goodreads.sources: two genre-page sources with the expected ids/tag', () => {
  const { sources } = require('../src/listsources/goodreads');
  const s = sources();
  assert.equal(s.length, 2);
  assert.deepEqual(s.map((x) => x.id), ['goodreads-most-read-adult-fiction', 'goodreads-new-releases-adult-fiction']);
  for (const x of s) {
    assert.equal(x.tag, 'Goodreads Adult Fiction');
    assert.equal(x.configured, true);
    assert.equal(typeof x.fetch, 'function');
  }
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
  // added/watching render as cover rows (title + author·list), the rest as lists
  assert.match(msg.html, /Theo of Golden<\/p>[\s\S]*?Allen Levi/);
  assert.match(msg.html, /Fresh Author · NYT Hardcover Fiction/);
  assert.match(msg.html, /<li>Never Showed — Ghost Writer<\/li>/);
});

test('buildDigest: a cover URL becomes an inline CID image + attachment', () => {
  const msg = buildDigest([
    { type: 'added', title: 'With Cover', author: 'A', cover: 'https://covers.example/c.jpg' },
    { type: 'watching', title: 'No Cover', author: 'B', list: 'L' },
  ]);
  assert.equal(msg.attachments.length, 1);
  assert.equal(msg.attachments[0].path, 'https://covers.example/c.jpg');
  assert.match(msg.html, new RegExp(`cid:${msg.attachments[0].cid}`));
  assert.match(msg.html, /📖/); // the coverless book gets the placeholder
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
