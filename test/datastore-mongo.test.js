'use strict';

// Integration: src/datastore.js against a REAL MongoDB through the real driver.
// Skipped unless MONGODB_TEST_URI points at a throwaway server, e.g.
//   docker run -d --rm -p 127.0.0.1:27099:27017 mongo:8
//   MONGODB_TEST_URI=mongodb://127.0.0.1:27099 npm test
// Optional DATASTORE_IT_DATA_DIR: a directory of COPIES of real store files to
// round-trip (seed → lose the machine → restore → byte-identical).
// Never point either at Atlas or the live files.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const URI = process.env.MONGODB_TEST_URI;
const skip = URI ? false : 'set MONGODB_TEST_URI to run against a real MongoDB';
const datastore = require('../src/datastore');

const STORES = [
  ['history', 'history.json', 'array'],
  ['watchlist', 'watchlist.json', 'array'],
  ['recipients', 'recipients.json', 'array'],
  ['recipient-groups', 'recipient-groups.json', 'array'],
  ['booktags', 'booktags.json', 'object'],
  ['lists', 'lists.json', 'object'],
  ['settings', 'settings.json', 'object'],
];

let client;
const dbName = `bookhunt_it_${process.pid}_${Date.now()}`;
after(async () => {
  if (client) {
    await client.db(dbName).dropDatabase().catch(() => {});
    await client.close();
  }
});

function define(dir) {
  datastore._reset();
  datastore._stores.clear();
  return STORES.map(([name, file, shape]) => datastore.defineStore(name, { file: path.join(dir, file), shape }));
}

test('real MongoDB: seed → machine lost → restore is byte-identical; later writes mirror', { skip }, async (t) => {
  const { MongoClient } = require('mongodb');
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 5000 });
  const env = { DATA_STORE: 'mongo', MONGODB_URI: URI, MONGODB_DB: dbName };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'datastore-it-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = process.env.DATASTORE_IT_DATA_DIR;
  for (const [, file, shape] of STORES) {
    const from = src && path.join(src, file);
    if (from && fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, file));
    else fs.writeFileSync(path.join(dir, file), JSON.stringify(shape === 'array'
      ? [{ id: 'a', title: 'Mr. Mercedes', nested: { 'key.with.dots': 1, $weird: true } }]
      : { '/app/books/Mr. Mercedes [Stephen King].epub': ['x'], seen: { 'a.b|c': { at: 'now' } } }, null, 2));
  }
  const original = Object.fromEntries(STORES.map(([, file]) => [file, JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')), null, 2)]));

  // 1. First boot: every store is seeded up.
  define(dir);
  const seeded = await datastore.init(env, { client });
  assert.deepEqual(Object.values(seeded), STORES.map(() => 'seeded'));
  assert.equal(await datastore.flush(30000), true);
  assert.equal(await client.db(dbName).collection('stores').countDocuments(), STORES.length);

  // 2. Disaster: the machine (all local files) is gone. A fresh boot restores.
  for (const [, file] of STORES) fs.rmSync(path.join(dir, file));
  const handles = define(dir);
  const restored = await datastore.init(env, { client });
  assert.deepEqual(Object.values(restored), STORES.map(() => 'restored'));
  for (const [, file] of STORES) {
    assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), original[file], `${file} restored byte-identical`);
  }

  // 3. Normal operation: a write lands in Mongo.
  const history = handles[0];
  history.mutate((l) => { l.unshift({ id: 'new', type: 'search', title: 'Heart of Glass' }); });
  assert.equal(await datastore.flush(30000), true);
  const doc = await client.db(dbName).collection('stores').findOne({ _id: 'history' });
  assert.equal(doc.data[0].id, 'new');
  assert.deepEqual(datastore.status().pending, []);
});
