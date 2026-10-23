'use strict';

// End-to-end searcher.search() against a fake forum (test/fake-forum.js): which
// passes run, in what order, and what they return — the real misses fixed on
// 2026-10-23 plus the speed rules (no index.php round-trip on a good cookie,
// no author-sets pass after a direct hit).

process.env.POLITE_GAP_MS = '0';
process.env.MOBILISM_USER = process.env.MOBILISM_USER || 'test-user';
process.env.MOBILISM_PASS = process.env.MOBILISM_PASS || 'test-pass';

const { test } = require('node:test');
const assert = require('node:assert');
const searcher = require('../src/searcher');
const { createFakeForum } = require('./fake-forum');

async function run(forum, query) {
  searcher._setSessionForTests(forum.page, forum.context);
  return searcher.search(query);
}

test('direct hit: one search, one topic, no index.php, no author-sets or fallback pass', async () => {
  const forum = createFakeForum({
    searches: { 'Project Hail Mary Andy Weir': [['Project Hail Mary by Andy Weir (.ePUB)', '1']] },
    topics: { 1: { title: 'Project Hail Mary by Andy Weir (.ePUB)', text: 'Project Hail Mary\nRequirements: .ePUB Reader, 2 MB' } },
  });
  const { results } = await run(forum, { title: 'Project Hail Mary', author: 'Andy Weir' });
  assert.deepEqual(results.map((r) => r.title), ['Project Hail Mary by Andy Weir (.ePUB)']);
  assert.deepEqual(forum.searchedFor(), ['Project Hail Mary Andy Weir'], 'no extra search passes');
  assert.ok(!forum.visits.some((v) => v.endsWith('/index.php')), 'no login round-trip on a good cookie');
});

test('Heart of Glass: only inside "4 Novels by …" — found by the author-sets pass', async () => {
  const forum = createFakeForum({
    searches: {
      'Heart of Glass Jennifer Hillier': [
        ['Heart of Glass by Jennifer Hillier [AB]', '10'],
        ['Heart of Glass: A Novel by Jennifer Hillier (.M4B)', '11'],
      ],
      'Jennifer Hillier epub': [
        ['4 Novels by Jennifer Hillier (.ePUB)', '20'],
        ['Wonderland by Jennifer Hillier (.ePUB)', '21'],
      ],
    },
    topics: {
      20: { title: '4 Novels by Jennifer Hillier (.ePUB)', text: '4 Novels by Jennifer Hillier\nRequirements: .ePUB Reader, 7.6 MB\nJar of Hearts: …\nHeart of Glass: a new thriller' },
    },
  });
  const { results } = await run(forum, { title: 'Heart of Glass', author: 'Jennifer Hillier' });
  assert.equal(results.length, 1);
  assert.equal(results[0].collection, true);
  assert.equal(results[0].matchedTitle, 'Heart of Glass');
  assert.ok(!forum.visits.some((v) => v.includes('t=10') || v.includes('t=11')), 'audiobooks never opened');
  assert.ok(!forum.visits.some((v) => v.includes('t=21')), 'single-book posts are not opened by the sets pass');
});

test('The Thoroughbreds: list co-author "and" vs forum "&" — query drops the connector, set is matched', async () => {
  const forum = createFakeForum({
    searches: {
      'The Thoroughbreds Elin Hilderbrand Shelby Cunningham': [['The Thoroughbreds by Elin Hilderbrand & Shelby Cunningham (.M4B)', '30']],
      'Elin Hilderbrand Shelby Cunningham epub': [['The Academy series by Elin Hilderbrand & Shelby Cunningham (.ePUB)', '31']],
    },
    topics: {
      31: { title: 'The Academy series by Elin Hilderbrand & Shelby Cunningham (.ePUB)', text: 'The Academy series by Elin Hilderbrand, Shelby Cunningham (Books 1-2)\nRequirements: .ePUB Reader, 3.2 MB\nThe Academy\nThe Thoroughbreds' },
    },
  });
  const { results } = await run(forum, { title: 'The Thoroughbreds', author: 'Elin Hilderbrand and Shelby Cunningham' });
  assert.deepEqual(results.map((r) => r.setTitle), ['The Academy series by Elin Hilderbrand & Shelby Cunningham (.ePUB)']);
});

test('nothing anywhere: author-sets then author fallback both run, result empty', async () => {
  const forum = createFakeForum({ searches: {} });
  const { results } = await run(forum, { title: 'Nonexistent Book', author: 'Nobody Real' });
  assert.deepEqual(results, []);
  assert.deepEqual(forum.searchedFor(), ['Nonexistent Book Nobody Real', 'Nobody Real epub', 'Nobody Real']);
});

test('dead session mid-search (cookie outlived it): re-login + reload, still finds the book', async () => {
  const forum = createFakeForum({
    loggedOutLoads: 1, // the first search page comes back logged out
    searches: { 'Project Hail Mary Andy Weir': [['Project Hail Mary by Andy Weir (.ePUB)', '1']] },
    topics: { 1: { title: 'Project Hail Mary by Andy Weir (.ePUB)', text: 'Project Hail Mary' } },
  });
  const { results } = await run(forum, { title: 'Project Hail Mary', author: 'Andy Weir' });
  assert.equal(results.length, 1);
  const searchLoads = forum.visits.filter((v) => v.includes('search.php')).length;
  assert.equal(searchLoads, 2, 'search page reloaded after the re-login');
  assert.ok(forum.visits.some((v) => v.endsWith('/index.php')), 'full login ran');
});

test('Mister Mercedes: variant word left out of the forum query, folded in the filter', async () => {
  const forum = createFakeForum({
    searches: { 'Mercedes Stephen King': [['Mr. Mercedes by Stephen King (.ePUB)', '40']] },
    topics: { 40: { title: 'Mr. Mercedes by Stephen King (.ePUB)', text: 'Mr. Mercedes' } },
  });
  const { results } = await run(forum, { title: 'Mister Mercedes', author: 'Stephen King' });
  assert.deepEqual(results.map((r) => r.title), ['Mr. Mercedes by Stephen King (.ePUB)']);
});

test('author-sets pass skips other authors\' sets that merely name the searched author', async () => {
  const forum = createFakeForum({
    searches: {
      'Pride and Prejudice Jane Austen': [],
      'Jane Austen epub': [
        ['Jane Austen Regency Life series by Maria Grace (.ePUB)', '50'],
        ['Jane Austen Collection by Jane Austen (.ePUB)', '51'],
      ],
    },
    topics: {
      50: { title: 'Jane Austen Regency Life series by Maria Grace (.ePUB)', text: 'Requirements: .ePUB\nPride and Prejudice' },
      51: { title: 'Jane Austen Collection by Jane Austen (.ePUB)', text: 'Requirements: .ePUB\nPride and Prejudice\nEmma' },
    },
  });
  const { results } = await run(forum, { title: 'Pride and Prejudice', author: 'Jane Austen' });
  assert.deepEqual(results.map((r) => r.setTitle), ['Jane Austen Collection by Jane Austen (.ePUB)']);
  assert.ok(!forum.visits.some((v) => v.includes('t=50')), "another author's set is never opened");
});
