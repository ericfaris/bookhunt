'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { cleanWatchInput, dueWatches, queryKey } = require('../src/watchlist');

// --- cleanWatchInput ---------------------------------------------------------

test('cleanWatchInput: trims, defaults sort, normalizes recipientIds', () => {
  const c = cleanWatchInput({ title: '  Dune ', author: ' Herbert ', sort: 'weird', recipientIds: ['a', 'a', 'b', 7] });
  assert.equal(c.title, 'Dune');
  assert.equal(c.author, 'Herbert');
  assert.equal(c.sort, 'newest'); // unknown sort → newest
  assert.deepEqual(c.recipientIds, ['a', 'b']); // de-duped, non-strings dropped
});

test('cleanWatchInput: keeps a valid "oldest" sort', () => {
  assert.equal(cleanWatchInput({ title: 'X', sort: 'oldest' }).sort, 'oldest');
});

test('cleanWatchInput: requires a title or an author', () => {
  assert.throws(() => cleanWatchInput({}), /title and\/or an author/i);
  assert.throws(() => cleanWatchInput({ title: '   ', author: '' }), /title and\/or an author/i);
});

test('cleanWatchInput: author-only is allowed', () => {
  assert.doesNotThrow(() => cleanWatchInput({ author: 'Orwell' }));
});

// --- queryKey ----------------------------------------------------------------

test('queryKey: case-insensitive identity of title+author', () => {
  assert.equal(queryKey({ title: 'Dune', author: 'Herbert' }), queryKey({ title: 'dune', author: 'HERBERT' }));
  assert.notEqual(queryKey({ title: 'Dune', author: 'Herbert' }), queryKey({ title: 'Dune', author: '' }));
});

// --- dueWatches --------------------------------------------------------------

const ISO = (ms) => new Date(ms).toISOString();

test('dueWatches: only active watches past the interval, oldest-checked first', () => {
  const now = 1_000_000_000_000;
  const interval = 30 * 60 * 1000;
  const watches = [
    { id: 'never', status: 'active', lastCheckedAt: null },
    { id: 'fresh', status: 'active', lastCheckedAt: ISO(now - 60_000) }, // checked 1 min ago → not due
    { id: 'stale', status: 'active', lastCheckedAt: ISO(now - interval - 1000) }, // due
    { id: 'paused', status: 'paused', lastCheckedAt: null }, // excluded
    { id: 'done', status: 'fulfilled', lastCheckedAt: null }, // excluded
  ];
  const due = dueWatches(watches, now, interval);
  assert.deepEqual(due.map((w) => w.id), ['never', 'stale']);
});

test('dueWatches: never-checked sorts before a long-ago check', () => {
  const now = 2_000_000_000_000;
  const interval = 1000;
  const due = dueWatches(
    [
      { id: 'old', status: 'active', lastCheckedAt: ISO(now - 10_000) },
      { id: 'never', status: 'active', lastCheckedAt: null },
    ],
    now,
    interval
  );
  assert.equal(due[0].id, 'never');
});

test('dueWatches: tolerates empty / undefined input', () => {
  assert.deepEqual(dueWatches(undefined, Date.now(), 1000), []);
  assert.deepEqual(dueWatches([], Date.now(), 1000), []);
});
