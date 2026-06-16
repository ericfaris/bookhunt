'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { cleanTags, attachTags, allTags, keyFor } = require('../src/booktags');

test('cleanTags: trims, drops blanks, collapses whitespace', () => {
  assert.deepEqual(cleanTags(['  sci fi  ', '', '   ', 'fantasy']), ['sci fi', 'fantasy']);
});

test('cleanTags: de-dupes case-insensitively, first spelling wins', () => {
  assert.deepEqual(cleanTags(['Fantasy', 'fantasy', 'FANTASY', 'Epic']), ['Fantasy', 'Epic']);
});

test('cleanTags: ignores non-strings and caps absurd input', () => {
  assert.deepEqual(cleanTags(['ok', 5, null, {}]), ['ok']);
  assert.deepEqual(cleanTags('not an array'), []);
  const many = Array.from({ length: 50 }, (_, i) => 'tag' + i);
  assert.equal(cleanTags(many).length, 25);
});

test('attachTags: merges stored tags by resolved savePath, default []', () => {
  const store = { [keyFor('/dl/a.epub')]: ['fav'] };
  const books = [{ id: '1', savePath: '/dl/a.epub' }, { id: '2', savePath: '/dl/b.epub' }];
  const merged = attachTags(books, store);
  assert.deepEqual(merged[0].tags, ['fav']);
  assert.deepEqual(merged[1].tags, []);
});

test('allTags: distinct, case-insensitive, sorted', () => {
  const store = { a: ['Sci-Fi', 'fantasy'], b: ['fantasy', 'Mystery'] };
  assert.deepEqual(allTags(store), ['fantasy', 'Mystery', 'Sci-Fi']);
});

test('allTags: empty store yields []', () => {
  assert.deepEqual(allTags({}), []);
  assert.deepEqual(allTags(undefined), []);
});
