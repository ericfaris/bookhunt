'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { parseSizeToBytes, isEpub, filterResults, sortResults } = require('../src/resultfilter');

test('parseSizeToBytes: parses KB/MB/GB and rejects junk', () => {
  assert.equal(parseSizeToBytes('1 KB'), 1024);
  assert.equal(parseSizeToBytes('2.4 MB'), Math.round(2.4 * 1024 * 1024));
  assert.equal(parseSizeToBytes('1GB'), 1024 ** 3);
  assert.equal(parseSizeToBytes('900 B'), 900);
  assert.equal(parseSizeToBytes(''), null);
  assert.equal(parseSizeToBytes('big'), null);
  assert.equal(parseSizeToBytes(null), null);
});

test('isEpub: lenient — only "other" is non-epub', () => {
  assert.equal(isEpub({ format: 'ePUB' }), true);
  assert.equal(isEpub({ format: 'epub' }), true);
  assert.equal(isEpub({ format: 'other' }), false);
  assert.equal(isEpub({}), false);
});

const R = [
  { title: 'A', format: 'ePUB', size: '2 MB', date: '2024-03-01' },
  { title: 'B', format: 'other', size: '10 MB', date: '2024-01-01' },
  { title: 'C', format: 'ePUB', size: null, date: null },
  { title: 'D', format: 'ePUB', size: '500 KB', date: '2024-05-01' },
];

test('filterResults: format filter', () => {
  assert.deepEqual(filterResults(R, { format: 'epub' }).map((r) => r.title), ['A', 'C', 'D']);
  assert.deepEqual(filterResults(R, { format: 'other' }).map((r) => r.title), ['B']);
  assert.equal(filterResults(R, { format: 'all' }).length, 4);
});

test('filterResults: size bounds keep unknown sizes', () => {
  // min 1 MB drops the 500 KB item but keeps the null-size item (C).
  assert.deepEqual(filterResults(R, { minMB: 1 }).map((r) => r.title), ['A', 'B', 'C']);
  // max 3 MB drops the 10 MB item; keeps null-size C.
  assert.deepEqual(filterResults(R, { maxMB: 3 }).map((r) => r.title), ['A', 'C', 'D']);
});

test('sortResults: relevance preserves input order', () => {
  assert.deepEqual(sortResults(R, 'relevance').map((r) => r.title), ['A', 'B', 'C', 'D']);
});

test('sortResults: by size, unknown sizes sink to the end', () => {
  assert.deepEqual(sortResults(R, 'largest').map((r) => r.title), ['B', 'A', 'D', 'C']);
  assert.deepEqual(sortResults(R, 'smallest').map((r) => r.title), ['D', 'A', 'B', 'C']);
});

test('sortResults: by date, unknown dates sink to the end', () => {
  assert.deepEqual(sortResults(R, 'newest').map((r) => r.title), ['D', 'A', 'B', 'C']);
  assert.deepEqual(sortResults(R, 'oldest').map((r) => r.title), ['B', 'A', 'D', 'C']);
});

test('sortResults: does not mutate the input array', () => {
  const copy = R.slice();
  sortResults(R, 'largest');
  assert.deepEqual(R, copy);
});
