'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { buildSources } = require('../src/sources');

test('buildSources: builds Anna’s Archive + LibGen links from title + author', () => {
  const s = buildSources({ title: 'Dune', author: 'Frank Herbert' });
  assert.equal(s.length, 2);
  const names = s.map((x) => x.name);
  assert.ok(names.includes('Anna’s Archive'));
  assert.ok(names.includes('Library Genesis'));
  for (const x of s) assert.match(x.url, /^https:\/\//);
});

test('buildSources: URL-encodes the combined query', () => {
  const [anna] = buildSources({ title: 'The Hobbit', author: 'J.R.R. Tolkien' });
  assert.ok(anna.url.includes(encodeURIComponent('The Hobbit J.R.R. Tolkien')));
});

test('buildSources: title-only and author-only both work', () => {
  assert.equal(buildSources({ title: '1984' }).length, 2);
  assert.equal(buildSources({ author: 'Orwell' }).length, 2);
});

test('buildSources: empty / whitespace input yields no links', () => {
  assert.deepEqual(buildSources({}), []);
  assert.deepEqual(buildSources({ title: '   ', author: '' }), []);
  assert.deepEqual(buildSources(), []);
});
