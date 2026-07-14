'use strict';

// Lost-update regression tests for the JSON stores.
//
// The bug these lock down: a caller read the WHOLE store into memory, awaited
// something slow (a cover lookup, an SMTP send), then wrote that snapshot back —
// silently erasing every entry appended in between (a watcher auto-download, a
// Kindle send, a search) and reverting every recipient edited in between.
//
// These tests use REAL files (via the HISTORY_FILE / RECIPIENTS_FILE seams, set
// before the modules are required) because the whole guarantee is about
// re-reading from disk — stubbing the store out would test nothing.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-stores-'));
process.env.HISTORY_FILE = path.join(TMP, 'history.json');
process.env.RECIPIENTS_FILE = path.join(TMP, 'recipients.json');

const { test } = require('node:test');
const assert = require('node:assert');

const history = require('../src/history');
const recipients = require('../src/recipients');

function resetHistory(entries = []) {
  fs.writeFileSync(process.env.HISTORY_FILE, JSON.stringify(entries, null, 2));
}
function resetRecipients(list = []) {
  fs.writeFileSync(process.env.RECIPIENTS_FILE, JSON.stringify(list, null, 2));
}

// --- history.mutate ---------------------------------------------------------

test('history.mutate: applies against a FRESH read, not a stale snapshot', async () => {
  resetHistory([]);
  history.add({ type: 'download', title: 'Old Book' });

  // Simulate the real bug's shape: a caller reads, awaits, then wants to write.
  const stale = history.readAll(); // snapshot taken BEFORE the slow work
  assert.equal(stale.length, 1);

  await new Promise((r) => setTimeout(r, 5)); // the await window…
  history.add({ type: 'download', title: 'Book Added While We Waited' }); // …a concurrent append

  // The old code did `writeAll(stale)` here, which erased the new book. mutate()
  // re-reads instead, so both survive.
  history.mutate((entries) => {
    for (const e of entries) if (e.title === 'Old Book') e.cover = 'https://x/c.jpg';
  });

  const after = history.readAll();
  const titles = after.map((e) => e.title);
  assert.ok(titles.includes('Book Added While We Waited'), 'concurrent append must survive the mutate');
  assert.ok(titles.includes('Old Book'));
  assert.equal(after.find((e) => e.title === 'Old Book').cover, 'https://x/c.jpg', 'mutation still applied');
});

test('history.mutate: proves the OLD pattern loses data (guards the regression)', async () => {
  resetHistory([]);
  history.add({ type: 'download', title: 'Old Book' });
  const stale = history.readAll();
  history.add({ type: 'download', title: 'Concurrent' });
  history.writeAll(stale); // the bug, reproduced verbatim
  assert.ok(
    !history.readAll().some((e) => e.title === 'Concurrent'),
    'sanity: writing a stale snapshot DOES erase — which is why callers must use mutate()'
  );
});

test('history.mutate: a replacement array is persisted', () => {
  resetHistory([]);
  history.add({ type: 'download', title: 'A' });
  history.add({ type: 'download', title: 'B' });
  history.mutate((entries) => entries.filter((e) => e.title !== 'A'));
  assert.deepEqual(history.readAll().map((e) => e.title), ['B']);
});

test('history.mutate: returning false aborts without writing', () => {
  resetHistory([]);
  history.add({ type: 'download', title: 'Keep' });
  const before = fs.readFileSync(process.env.HISTORY_FILE, 'utf8');
  history.mutate((entries) => {
    entries.length = 0; // even a destructive in-place edit must not be persisted
    return false;
  });
  assert.equal(fs.readFileSync(process.env.HISTORY_FILE, 'utf8'), before, 'file untouched');
  assert.deepEqual(history.readAll().map((e) => e.title), ['Keep']);
});

// --- recipients.mutate ------------------------------------------------------

test('recipients.mutate: applies against a FRESH read, not a stale snapshot', async () => {
  resetRecipients([]);
  const alice = recipients.add({ name: 'Alice', email: 'alice@example.com' });

  const stale = recipients.readAll(); // snapshot before the slow SMTP loop
  await new Promise((r) => setTimeout(r, 5));
  const bob = recipients.add({ name: 'Bob', email: 'bob@example.com' }); // added mid-send

  recipients.mutate((list) => {
    const t = list.find((r) => r.id === alice.id);
    t.readerNotifiedAt = '2026-07-13T00:00:00Z';
  });

  const after = recipients.readAll();
  assert.equal(after.length, 2, 'the recipient added mid-send must survive');
  assert.ok(after.find((r) => r.id === bob.id), 'Bob still there');
  assert.equal(after.find((r) => r.id === alice.id).readerNotifiedAt, '2026-07-13T00:00:00Z');
  assert.equal(stale.length, 1); // the snapshot was indeed stale
});

test('recipients.mutate: does not resurrect a recipient deleted mid-flight', () => {
  resetRecipients([]);
  const alice = recipients.add({ name: 'Alice', email: 'alice@example.com' });
  recipients.remove(alice.id); // deleted while we were "sending"

  // The stamp-after-send path: target is gone, so abort rather than re-add it.
  recipients.mutate((list) => {
    const t = list.find((r) => r.id === alice.id);
    if (!t) return false;
    t.readerNotifiedAt = 'now';
  });

  assert.deepEqual(recipients.readAll(), [], 'deleted recipient must stay deleted');
});
