'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { cleanWatchInput, dueWatches, queryKey, readJsonList, writeJsonList, setStatus } = require('../src/watchlist');

// Note: add/remove/update operate on the hardcoded repo-root watchlist.json
// (bind-mounted into Docker), so they are deliberately NOT exercised here — doing
// so would clobber the live file. The auto-remove behavior (strict match → removed,
// titleMatch null → fulfilled, titleMatch false → unchanged) is covered in
// test/watcher.test.js via the watchlist.remove mock seam instead.

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

// --- writeJsonList / readJsonList (write hardening) --------------------------
// These operate exclusively on a temp file — never the live watchlist.json.

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchlist-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'watchlist.json');
}

// The tmp companion lives in the shared os.tmpdir() (see tmpPathFor in
// src/watchlist.js — /app is root-owned in production, so a tmp file can't be
// created next to the target there). Since it's shared, tests must clean it up
// explicitly rather than relying on tmpFile()'s per-test directory removal.
function tmpCompanion(file) {
  return path.join(os.tmpdir(), path.basename(file) + '.tmp');
}

test('writeJsonList: forced EXDEV rename failure still leaves valid JSON (acceptance #4)', (t) => {
  const file = tmpFile(t);
  t.after(() => fs.rmSync(tmpCompanion(file), { force: true }));
  const newList = [{ id: 'w_1', status: 'active' }, { id: 'w_2', status: 'fulfilled' }];
  // Seed with something different so we can prove the new data landed.
  fs.writeFileSync(file, JSON.stringify([{ id: 'old' }], null, 2), 'utf8');
  const origRename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }); };
  t.after(() => { fs.renameSync = origRename; });
  writeJsonList(file, newList);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), newList);
  assert.equal(fs.existsSync(tmpCompanion(file)), false, 'verified tmp copy should be removed after a good fallback write');
});

test('readJsonList: interrupted fallback write is recoverable from tmp (acceptance #4)', (t) => {
  const file = tmpFile(t);
  t.after(() => fs.rmSync(tmpCompanion(file), { force: true }));
  const newList = [{ id: 'w_1', status: 'active' }];
  // Simulate the crash state: complete data in the tmp companion, truncated garbage in target.
  fs.writeFileSync(tmpCompanion(file), JSON.stringify(newList, null, 2), 'utf8');
  fs.writeFileSync(file, '[{"id":"w_1", ', 'utf8');
  assert.deepEqual(readJsonList(file), newList);
  // The target itself must now be restored to valid JSON.
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), newList);
});

test('readJsonList: corrupt file with no/corrupt tmp returns [], missing file returns []', (t) => {
  const file = tmpFile(t);
  t.after(() => fs.rmSync(tmpCompanion(file), { force: true }));
  // Corrupt target, no tmp.
  fs.writeFileSync(file, 'not json at all', 'utf8');
  assert.deepEqual(readJsonList(file), []);
  // Corrupt target, corrupt tmp.
  fs.writeFileSync(tmpCompanion(file), 'also garbage', 'utf8');
  assert.deepEqual(readJsonList(file), []);
  // Missing file.
  const missing = path.join(path.dirname(file), 'does-not-exist.json');
  assert.deepEqual(readJsonList(missing), []);
});

test('writeJsonList → readJsonList: happy-path round-trip, no tmp left behind', (t) => {
  const file = tmpFile(t);
  t.after(() => fs.rmSync(tmpCompanion(file), { force: true }));
  const list = [{ id: 'w_1', status: 'active', title: 'Dune' }];
  writeJsonList(file, list);
  assert.deepEqual(readJsonList(file), list);
  assert.equal(fs.existsSync(tmpCompanion(file)), false, 'rename path should not leave a tmp file');
});

test('writeJsonList: EACCES creating the tmp companion still falls back safely (production regression guard)', (t) => {
  const file = tmpFile(t);
  t.after(() => fs.rmSync(tmpCompanion(file), { force: true }));
  const newList = [{ id: 'w_1', status: 'active' }];
  fs.writeFileSync(file, JSON.stringify([{ id: 'old' }], null, 2), 'utf8');
  const origWrite = fs.writeFileSync;
  let calls = 0;
  fs.writeFileSync = (dest, ...rest) => {
    calls += 1;
    // Fail only the very first write attempt (the tmp companion) with EACCES,
    // matching the real /app-is-root-owned production failure — let every
    // later call (the in-place fallback write) go through normally.
    if (calls === 1) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return origWrite(dest, ...rest);
  };
  t.after(() => { fs.writeFileSync = origWrite; });
  writeJsonList(file, newList);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), newList);
});

// --- setStatus: status whitelist (issue: auto-expire after MAX_NO_MATCH_CHECKS) --
// setStatus() reads/writes the hardcoded repo-root watchlist.json, same
// live-file constraint noted at the top of this file — but with an id that
// can't match any real watch, update() finds nothing and returns without ever
// writing (see src/watchlist.js update()), so these are safe to run against
// the real file: they exercise only the validation guard, never a write.
test('setStatus: rejects an unrecognized status before touching the store', () => {
  assert.throws(() => setStatus('__no-such-watch__', 'bogus'), /Invalid status/);
});

test('setStatus: "expired" is now a recognized status (no-op on a nonexistent id)', () => {
  assert.doesNotThrow(() => setStatus('__no-such-watch__', 'expired'));
  assert.equal(setStatus('__no-such-watch__', 'expired'), null, 'nonexistent id → no match → null, no write');
});
