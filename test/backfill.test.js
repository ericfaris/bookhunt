'use strict';

// One-time Goodreads "Most Read" backfill (issue #33 follow-up). Coverage for
// the three pure surfaces named in the plan's acceptance criteria — all
// offline/pure, no fetch, no real lists.json.

const { test } = require('node:test');
const assert = require('node:assert');

const { buildBackfillQueue } = require('../src/lists');
const { backfillDrawCount, classifyBackfillEntry, buildDigest, BACKFILL_MAX_PER_RUN } = require('../src/listwatcher');

// --- buildBackfillQueue -------------------------------------------------------

test('buildBackfillQueue: excludes already-owned books', () => {
  const entries = [
    { title: 'Owned Book', author: 'A' },
    { title: 'Unowned Book', author: 'B' },
  ];
  const out = buildBackfillQueue(entries, {
    isOwned: (e) => e.title === 'Owned Book',
    activeKeys: new Set(),
    keyOf: (e) => `${e.title.toLowerCase()}|${(e.author || '').toLowerCase()}`,
  });
  assert.deepEqual(out, [{ title: 'Unowned Book', author: 'B' }]);
});

test('buildBackfillQueue: excludes entries already actively watched (by queryKey)', () => {
  const entries = [
    { title: 'Watched Book', author: 'A' },
    { title: 'Fresh Book', author: 'B' },
  ];
  const keyOf = (e) => `${e.title.toLowerCase()}|${(e.author || '').toLowerCase()}`;
  const out = buildBackfillQueue(entries, {
    isOwned: () => false,
    activeKeys: new Set([keyOf({ title: 'Watched Book', author: 'A' })]),
    keyOf,
  });
  assert.deepEqual(out, [{ title: 'Fresh Book', author: 'B' }]);
});

test('buildBackfillQueue: dedupes intra-list duplicates by key', () => {
  const entries = [
    { title: 'Same Book', author: 'A' },
    { title: 'same book', author: 'a' }, // different casing, same key
  ];
  const keyOf = (e) => `${e.title.toLowerCase()}|${(e.author || '').toLowerCase()}`;
  const out = buildBackfillQueue(entries, { isOwned: () => false, activeKeys: new Set(), keyOf });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { title: 'Same Book', author: 'A' });
});

test('buildBackfillQueue: drops junk rows with no title', () => {
  const entries = [null, { author: 'No Title' }, { title: '', author: 'Also No Title' }, { title: 'Real Book', author: 'C' }];
  const out = buildBackfillQueue(entries, {
    isOwned: () => false,
    activeKeys: new Set(),
    keyOf: (e) => `${e.title.toLowerCase()}|${(e.author || '').toLowerCase()}`,
  });
  assert.deepEqual(out, [{ title: 'Real Book', author: 'C' }]);
});

// --- backfillDrawCount --------------------------------------------------------

test('backfillDrawCount: live-first budget fully spent → 0', () => {
  assert.equal(
    backfillDrawCount({ watchedThisRun: 10, maxPerRun: 10, backfillMaxPerRun: BACKFILL_MAX_PER_RUN, queueLength: 20 }),
    0
  );
});

test('backfillDrawCount: leftover larger than the backfill cap is clamped to the cap', () => {
  assert.equal(
    backfillDrawCount({ watchedThisRun: 0, maxPerRun: 10, backfillMaxPerRun: 5, queueLength: 20 }),
    5
  );
});

test('backfillDrawCount: leftover smaller than the cap equals the leftover', () => {
  assert.equal(
    backfillDrawCount({ watchedThisRun: 8, maxPerRun: 10, backfillMaxPerRun: 5, queueLength: 20 }),
    2
  );
});

test('backfillDrawCount: queueLength smaller than both equals queueLength', () => {
  assert.equal(
    backfillDrawCount({ watchedThisRun: 0, maxPerRun: 10, backfillMaxPerRun: 5, queueLength: 2 }),
    2
  );
});

test('backfillDrawCount: never negative', () => {
  assert.equal(
    backfillDrawCount({ watchedThisRun: 15, maxPerRun: 10, backfillMaxPerRun: 5, queueLength: 20 }),
    0
  );
});

// --- classifyBackfillEntry ----------------------------------------------------

test('classifyBackfillEntry: owned wins first', () => {
  assert.equal(classifyBackfillEntry({ owned: true, activeCount: 0, maxActive: 40 }), 'owned');
  assert.equal(classifyBackfillEntry({ owned: true, activeCount: 40, maxActive: 40 }), 'owned');
});

test('classifyBackfillEntry: pool full defers (NOT skip-full — the divergence from classifyEntrant)', () => {
  const decision = classifyBackfillEntry({ owned: false, activeCount: 40, maxActive: 40 });
  assert.equal(decision, 'defer');
  assert.notEqual(decision, 'skip-full');
});

test('classifyBackfillEntry: room in the pool → watch', () => {
  assert.equal(classifyBackfillEntry({ owned: false, activeCount: 5, maxActive: 40 }), 'watch');
});

// --- digest: backfill-done section --------------------------------------------

test('buildDigest: a backfill-done event renders the "Backfill complete" section', () => {
  const msg = buildDigest([{ type: 'backfill-done', count: 12 }]);
  assert.match(msg.text, /Backfill complete[\s\S]*Most Read backfill finished — 12 added to your watchlist/);
  assert.match(msg.html, /Backfill complete/);
  assert.match(msg.html, /12 added to your watchlist/);
});
