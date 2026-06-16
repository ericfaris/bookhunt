'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { epubStats } = require('../src/health');

test('epubStats: counts only .epub files and sums their bytes', () => {
  const stats = epubStats([
    { name: 'a.epub', size: 1000 },
    { name: 'b.EPUB', size: 2000 },
    { name: 'notes.txt', size: 500 },
    { name: 'c.pdf', size: 9999 },
  ]);
  assert.equal(stats.count, 2);
  assert.equal(stats.totalBytes, 3000);
});

test('epubStats: tolerates missing/invalid sizes', () => {
  const stats = epubStats([
    { name: 'a.epub' },
    { name: 'b.epub', size: NaN },
    { name: 'c.epub', size: 1024 },
  ]);
  assert.equal(stats.count, 3);
  assert.equal(stats.totalBytes, 1024);
});

test('epubStats: empty / junk input yields zeros', () => {
  assert.deepEqual(epubStats([]), { count: 0, totalBytes: 0 });
  assert.deepEqual(epubStats(undefined), { count: 0, totalBytes: 0 });
  assert.deepEqual(epubStats([null, 5, {}]), { count: 0, totalBytes: 0 });
});
