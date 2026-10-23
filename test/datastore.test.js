'use strict';

// src/datastore.js: the JSON stores' hardened file I/O and their Atlas mirror.
// Everything runs against temp files and an in-memory fake Mongo — never the
// live data or Atlas.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const datastore = require('../src/datastore');
const { createFakeMongo } = require('./fake-mongo');

const ENV = { DATA_STORE: 'mongo', MONGODB_URI: 'mongodb+srv://user:secret@example.invalid/', MONGODB_DB: 'bookhunt' };

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'datastore-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(file, value, mtime) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  if (mtime) fs.utimesSync(file, new Date(mtime), new Date(mtime));
}

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

beforeEach(() => {
  datastore._reset();
  datastore._stores.clear();
});

// --- file mode -------------------------------------------------------------------

test('file mode: read/write/mutate behave like the old per-module stores', async (t) => {
  const dir = tmpDir(t);
  const s = datastore.defineStore('history', { file: path.join(dir, 'h.json') });
  assert.deepEqual(s.read(), [], 'missing file → empty array');
  s.write([{ id: 1 }]);
  assert.deepEqual(s.read(), [{ id: 1 }]);
  // mutate: in-place, replacement, and abort
  s.mutate((l) => { l.push({ id: 2 }); });
  assert.deepEqual(s.read().map((e) => e.id), [1, 2]);
  s.mutate(() => [{ id: 9 }]);
  assert.deepEqual(s.read(), [{ id: 9 }]);
  const before = fs.readFileSync(s.file, 'utf8');
  s.mutate(() => false);
  assert.equal(fs.readFileSync(s.file, 'utf8'), before, 'false aborts without writing');
  // a non-array return (e.g. unshift's length) persists the mutated list, as before
  s.mutate((l) => l.unshift({ id: 0 }));
  assert.deepEqual(s.read().map((e) => e.id), [0, 9]);
  assert.deepEqual(await datastore.init({}), {}, 'DATA_STORE unset → file mode');
  assert.equal(datastore.status().mode, 'file');
});

test('object stores: wrong shape on disk reads as {} and never as an array', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 's.json');
  const s = datastore.defineStore('settings', { file, shape: 'object' });
  assert.deepEqual(s.read(), {});
  writeFile(file, [1, 2]);
  assert.deepEqual(s.read(), {});
  s.write({ a: 1 });
  assert.deepEqual(s.read(), { a: 1 });
});

test('tmpPathFor: distinct per full path, so same-named stores never share a tmp copy', () => {
  const a = datastore.tmpPathFor('/a/history.json');
  const b = datastore.tmpPathFor('/b/history.json');
  assert.notEqual(a, b);
  assert.equal(path.dirname(a), os.tmpdir());
  assert.match(path.basename(a), /^history\.json\.[0-9a-f]{10}\.tmp$/);
});

// --- config ------------------------------------------------------------------------

test('init: rejects an unknown DATA_STORE and names missing vars, never values', async () => {
  await assert.rejects(datastore.init({ DATA_STORE: 'sqlite' }), /DATA_STORE must be "file" or "mongo"/);
  await assert.rejects(datastore.init({ DATA_STORE: 'mongo' }), /MONGODB_URI, MONGODB_DB are not set/);
  await assert.rejects(
    datastore.init({ DATA_STORE: 'mongo', MONGODB_URI: 'mongodb://u:hunter2@h/' }),
    (err) => /MONGODB_DB is not set/.test(err.message) && !/hunter2/.test(err.message)
  );
});

// --- reconcile at startup -----------------------------------------------------------

test('startup: no Atlas copy yet → local file is seeded up (first run / migration)', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'w.json');
  writeFile(file, [{ id: 'w1' }]);
  datastore.defineStore('watchlist', { file });
  const fake = createFakeMongo();
  const out = await datastore.init(ENV, { client: fake.client });
  assert.deepEqual(out, { watchlist: 'seeded' });
  await datastore.flush();
  assert.deepEqual(fake.docs.get('watchlist').data, [{ id: 'w1' }]);
  assert.equal(fake.docs.get('watchlist').bytes > 0, true);
});

test('startup: local file missing (rebuilt machine) → restored from Atlas, stamped with the Atlas time', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'h.json');
  datastore.defineStore('history', { file });
  const fake = createFakeMongo();
  const at = Date.parse('2026-10-20T12:00:00Z');
  fake.seed('history', [{ id: 'a' }, { id: 'b' }], at);
  const out = await datastore.init(ENV, { client: fake.client });
  assert.deepEqual(out, { history: 'restored' });
  assert.deepEqual(read(file), [{ id: 'a' }, { id: 'b' }]);
  assert.equal(Math.round(fs.statSync(file).mtimeMs), at);
  assert.equal(fake.writes.length, 0, 'restoring must not write back');
});

test('startup: Atlas newer than the local file → Atlas wins', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'r.json');
  writeFile(file, [{ id: 'old' }], '2026-10-01T00:00:00Z');
  datastore.defineStore('recipients', { file });
  const fake = createFakeMongo();
  fake.seed('recipients', [{ id: 'new' }], '2026-10-10T00:00:00Z');
  await datastore.init(ENV, { client: fake.client });
  assert.deepEqual(read(file), [{ id: 'new' }]);
});

test('startup: local newer than Atlas (an Atlas write failed before shutdown) → local is pushed', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'r.json');
  writeFile(file, [{ id: 'local-newer' }], '2026-10-10T00:00:00Z');
  datastore.defineStore('recipients', { file });
  const fake = createFakeMongo();
  fake.seed('recipients', [{ id: 'stale' }], '2026-10-01T00:00:00Z');
  const out = await datastore.init(ENV, { client: fake.client });
  assert.deepEqual(out, { recipients: 'pushed-newer' });
  await datastore.flush();
  assert.deepEqual(fake.docs.get('recipients').data, [{ id: 'local-newer' }]);
  assert.deepEqual(read(file), [{ id: 'local-newer' }], 'local untouched');
});

test('startup: a just-restored file is not pushed back on the next boot', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'h.json');
  datastore.defineStore('history', { file });
  const fake = createFakeMongo();
  fake.seed('history', [{ id: 'a' }], Date.now() - 60_000);
  await datastore.init(ENV, { client: fake.client });
  datastore._reset();
  const out = await datastore.init(ENV, { client: fake.client });
  assert.deepEqual(out, { history: 'restored' });
  assert.equal(fake.writes.length, 0);
});

test('startup: Atlas unreachable + local files present → runs on local, status reports it', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'w.json');
  writeFile(file, [{ id: 'w1' }]);
  const s = datastore.defineStore('watchlist', { file });
  const fake = createFakeMongo();
  fake.down = true;
  const out = await datastore.init(ENV, { client: fake.client });
  assert.equal(out, null);
  const st = datastore.status();
  assert.equal(st.connected, false);
  assert.deepEqual(st.unreconciled, ['watchlist']);
  assert.ok(!JSON.stringify(st).includes('secret'), 'status never leaks the URI');
  // Writes still work locally and are NOT pushed while unreconciled.
  s.write([{ id: 'w2' }]);
  assert.deepEqual(read(file), [{ id: 'w2' }]);
  assert.equal(fake.writes.length, 0);
});

test('startup: Atlas unreachable + a local file missing → refuses to start (never overwrite Atlas with empty)', async (t) => {
  const dir = tmpDir(t);
  writeFile(path.join(dir, 'w.json'), []);
  datastore.defineStore('watchlist', { file: path.join(dir, 'w.json') });
  datastore.defineStore('history', { file: path.join(dir, 'missing.json') });
  const fake = createFakeMongo();
  fake.down = true;
  await assert.rejects(
    datastore.init(ENV, { client: fake.client }),
    (err) => /refusing to start empty/.test(err.message) && /history/.test(err.message) && !/secret/.test(err.message)
  );
});

// --- write mirroring ------------------------------------------------------------------

test('writes after startup are mirrored; bursts coalesce to the latest value', async (t) => {
  const dir = tmpDir(t);
  const s = datastore.defineStore('history', { file: path.join(dir, 'h.json') });
  const fake = createFakeMongo();
  await datastore.init(ENV, { client: fake.client });
  for (let i = 1; i <= 20; i++) s.mutate((l) => { l.push({ id: i }); });
  await datastore.flush();
  assert.equal(fake.docs.get('history').data.length, 20, 'latest value landed');
  assert.ok(fake.writes.length < 20, `coalesced (${fake.writes.length} writes for 20 mutations)`);
  assert.deepEqual(datastore.status().pending, []);
});

test('a failed Atlas write is retried until it lands; local data is never blocked', async (t) => {
  const dir = tmpDir(t);
  const s = datastore.defineStore('booktags', { file: path.join(dir, 'b.json'), shape: 'object' });
  const fake = createFakeMongo();
  await datastore.init(ENV, { client: fake.client });
  fake.failNext(1);
  s.write({ '/books/a.epub': ['fav'] });
  assert.deepEqual(s.read(), { '/books/a.epub': ['fav'] }, 'local write is synchronous');
  await datastore.flush(5000);
  assert.deepEqual(fake.docs.get('booktags').data, { '/books/a.epub': ['fav'] });
  assert.equal(datastore.status().lastError, null, 'cleared after the retry succeeded');
});

test('non-mirrored stores (covers cache) never touch Atlas', async (t) => {
  const dir = tmpDir(t);
  const c = datastore.defineStore('covers-cache', { file: path.join(dir, 'c.json'), shape: 'object', mirror: false });
  writeFile(c.file, { k: { cover: null } });
  const fake = createFakeMongo();
  const out = await datastore.init(ENV, { client: fake.client });
  assert.deepEqual(out, {});
  c.write({ k2: { cover: 'x' } });
  await datastore.flush();
  assert.equal(fake.docs.size, 0);
  assert.equal(fake.writes.length, 0);
});

test('object keys with dots survive the round trip (booktags/lists keys are paths and titles)', async (t) => {
  const dir = tmpDir(t);
  const s = datastore.defineStore('booktags', { file: path.join(dir, 'b.json'), shape: 'object' });
  const fake = createFakeMongo();
  await datastore.init(ENV, { client: fake.client });
  const value = { '/app/books/Mr. Mercedes [Stephen King].epub': ['thriller'] };
  s.write(value);
  await datastore.flush();
  assert.deepEqual(fake.docs.get('booktags').data, value);
});
