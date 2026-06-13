'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { parseBatchInput, splitTitleAuthor, classifyBatchOutcome, runSequential, MAX_BATCH } =
  require('../src/batch');

// --- splitTitleAuthor -------------------------------------------------------

test('splitTitleAuthor: spaced em/en/hyphen dash separates title and author', () => {
  assert.deepEqual(splitTitleAuthor('1984 — George Orwell'), { title: '1984', author: 'George Orwell' });
  assert.deepEqual(splitTitleAuthor('1984 – George Orwell'), { title: '1984', author: 'George Orwell' });
  assert.deepEqual(splitTitleAuthor('1984 - George Orwell'), { title: '1984', author: 'George Orwell' });
});

test('splitTitleAuthor: comma separates when there is no dash', () => {
  assert.deepEqual(splitTitleAuthor('1984, George Orwell'), { title: '1984', author: 'George Orwell' });
});

test('splitTitleAuthor: title-only line has empty author', () => {
  assert.deepEqual(splitTitleAuthor('Just a Title'), { title: 'Just a Title', author: '' });
});

test('splitTitleAuthor: hyphenated title without spaces stays intact', () => {
  assert.deepEqual(splitTitleAuthor('Spider-Man'), { title: 'Spider-Man', author: '' });
});

test('splitTitleAuthor: splits on the FIRST spaced dash only', () => {
  assert.deepEqual(
    splitTitleAuthor('The Lord of the Rings — J.R.R. Tolkien'),
    { title: 'The Lord of the Rings', author: 'J.R.R. Tolkien' }
  );
});

// --- parseBatchInput --------------------------------------------------------

test('parseBatchInput: parses mixed separators, one per line', () => {
  const entries = parseBatchInput('1984 — George Orwell\nDune, Frank Herbert\nUntitled Book');
  assert.deepEqual(entries, [
    { title: '1984', author: 'George Orwell' },
    { title: 'Dune', author: 'Frank Herbert' },
    { title: 'Untitled Book', author: '' },
  ]);
});

test('parseBatchInput: ignores blank/whitespace-only lines', () => {
  const entries = parseBatchInput('\n  \n1984\n\n  \nDune\n');
  assert.deepEqual(entries, [
    { title: '1984', author: '' },
    { title: 'Dune', author: '' },
  ]);
});

test('parseBatchInput: caps the number of entries', () => {
  const many = Array.from({ length: 100 }, (_, i) => `Book ${i}`).join('\n');
  assert.equal(parseBatchInput(many).length, MAX_BATCH);
  assert.equal(parseBatchInput(many, { max: 5 }).length, 5);
});

test('parseBatchInput: caps field length', () => {
  const long = 'T'.repeat(500) + ' — ' + 'A'.repeat(500);
  const [e] = parseBatchInput(long);
  assert.equal(e.title.length, 300);
  assert.equal(e.author.length, 300);
});

test('parseBatchInput: empty / non-string input yields []', () => {
  assert.deepEqual(parseBatchInput(''), []);
  assert.deepEqual(parseBatchInput(undefined), []);
  assert.deepEqual(parseBatchInput(null), []);
});

// --- classifyBatchOutcome ---------------------------------------------------

test('classifyBatchOutcome: maps result counts to states', () => {
  assert.equal(classifyBatchOutcome({ results: [] }).status, 'not-found');
  assert.equal(classifyBatchOutcome({ results: [{ url: 'a' }] }).status, 'found');
  assert.equal(classifyBatchOutcome({ results: [{ url: 'a' }, { url: 'b' }] }).status, 'multiple');
});

test('classifyBatchOutcome: an error wins regardless of results', () => {
  const out = classifyBatchOutcome({ error: 'boom', results: [{ url: 'a' }] });
  assert.equal(out.status, 'error');
  assert.equal(out.error, 'boom');
});

test('classifyBatchOutcome: missing results → not-found', () => {
  assert.equal(classifyBatchOutcome({}).status, 'not-found');
});

// --- runSequential (isolation + ordering) -----------------------------------

test('runSequential: runs in order and collects values', async () => {
  const order = [];
  const out = await runSequential([1, 2, 3], async (n) => {
    order.push(n);
    return n * 10;
  });
  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(out.map((r) => r.value), [10, 20, 30]);
  assert.ok(out.every((r) => r.ok));
});

test('runSequential: one failure does not sink the batch', async () => {
  const out = await runSequential(['a', 'BAD', 'c'], async (x) => {
    if (x === 'BAD') throw new Error('kaboom');
    return x.toUpperCase();
  });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((r) => r.ok), [true, false, true]);
  assert.equal(out[1].error, 'kaboom');
  assert.equal(out[2].value, 'C'); // ran despite the earlier failure
});

test('runSequential: emits start/ok/error progress per item', async () => {
  const events = [];
  await runSequential(['ok', 'bad'], async (x) => {
    if (x === 'bad') throw new Error('nope');
    return 1;
  }, (ev) => events.push(ev));
  assert.deepEqual(events.map((e) => e.phase), ['start', 'ok', 'start', 'error']);
  assert.deepEqual(events.filter((e) => e.phase !== 'start').map((e) => e.index), [1, 2]);
});

test('runSequential: empty list yields []', async () => {
  assert.deepEqual(await runSequential([], async () => 1), []);
  assert.deepEqual(await runSequential(undefined, async () => 1), []);
});

// Simulates the batch-search worker contract: search errors become classified
// outcomes (not throws), so the batch keeps going and the bad entry is reported.
test('runSequential + classifyBatchOutcome: models the batch-search worker', async () => {
  const entries = [
    { title: 'Found Once', _results: [{ url: 'x' }] },
    { title: 'Throws', _throw: true },
    { title: 'Many', _results: [{ url: 'a' }, { url: 'b' }] },
    { title: 'None', _results: [] },
  ];
  const worker = async (e) => {
    try {
      if (e._throw) throw new Error('search blew up');
      return { ...classifyBatchOutcome({ results: e._results }) };
    } catch (err) {
      return { status: 'error', error: err.message };
    }
  };
  const out = await runSequential(entries, worker);
  assert.deepEqual(out.map((r) => r.value.status), ['found', 'error', 'multiple', 'not-found']);
  assert.ok(out.every((r) => r.ok), 'worker never throws, so every item is ok at the runner level');
});
