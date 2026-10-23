'use strict';

// Minimal in-memory stand-in for the MongoClient surface src/datastore.js uses
// (connect → db → collection → findOne / replaceOne upsert). Tests never touch
// Atlas. `failNext(n)` / `down` simulate an outage; `writes` records every
// replaceOne so tests can assert coalescing.

function createFakeMongo() {
  const docs = new Map();
  const fake = {
    docs,
    writes: [],
    down: false,
    failures: 0,
    connectError: null,
    failNext(n = 1) { fake.failures = n; },
    seed(id, data, updatedAt) {
      docs.set(id, { _id: id, data: structuredClone(data), updatedAt: new Date(updatedAt) });
    },
    client: {
      async connect() {
        if (fake.connectError || fake.down) throw fake.connectError || new Error('connect ECONNREFUSED');
      },
      db() {
        return {
          collection() {
            return {
              async findOne({ _id }) {
                if (fake.down) throw new Error('server selection timed out');
                const d = docs.get(_id);
                return d ? structuredClone(d) : null;
              },
              async replaceOne({ _id }, doc) {
                if (fake.down) throw new Error('server selection timed out');
                if (fake.failures > 0) { fake.failures -= 1; throw new Error('transient write failure'); }
                fake.writes.push(structuredClone(doc));
                docs.set(_id, structuredClone(doc));
                return { acknowledged: true };
              },
            };
          },
        };
      },
    },
  };
  return fake;
}

module.exports = { createFakeMongo };
