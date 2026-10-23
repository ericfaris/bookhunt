'use strict';

// src/catalog.js is shared transport only: spell-correction and cover lookup
// must send exactly the requests they sent before the refactor, and
// correction must still fail fast (no retries) because it runs before every
// search.

const { test } = require('node:test');
const assert = require('node:assert');
const catalog = require('../src/catalog');
const correct = require('../src/correct');
const covers = require('../src/covers');

function recorder(status = 200, body = {}) {
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(url);
    assert.equal(init.headers['User-Agent'], 'bookhunt/1.0');
    return { ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: () => null } };
  };
  return { urls, fetchImpl };
}

test('correct: same Google Books + Open Library URLs as before', async () => {
  const r = recorder(200, {});
  await correct.correct({ title: 'Heart of Glass', author: 'Jennifer Hillier' }, { fetchImpl: r.fetchImpl, apiKey: 'K' });
  assert.deepEqual(r.urls.sort(), [
    'https://openlibrary.org/search.json?q=Heart%20of%20Glass&limit=5&fields=title,author_name',
    'https://www.googleapis.com/books/v1/volumes?q=Heart%20of%20Glass%20Jennifer%20Hillier&maxResults=5&country=US&key=K',
  ]);
});

test('correct: a 429/5xx is NOT retried (fails open immediately)', async () => {
  const r = recorder(429);
  const out = await correct.correct({ title: 'Heart of Glas', author: 'Jennifer Hillier' }, { fetchImpl: r.fetchImpl });
  assert.equal(out.corrected, false);
  assert.equal(r.urls.length, 2, 'one call per source, no retries');
});

test('covers: Google query keeps maxResults=10 and the API key', async () => {
  const r = recorder(200, {});
  await covers.lookupDetailed({ title: 'Heart of Glass', author: 'Jennifer Hillier' }, { fetchImpl: r.fetchImpl, apiKey: 'K', retryDelays: [] });
  const google = r.urls.filter((u) => u.startsWith(catalog.GOOGLE_BOOKS_URL));
  assert.ok(google.length >= 1);
  for (const u of google) assert.match(u, /&maxResults=10&country=US&key=K$/);
  assert.ok(r.urls.some((u) => u.startsWith('https://openlibrary.org/search.json?limit=10&fields=title%2Cauthor_name%2Ccover_i&title=Heart+of+Glass&author=Jennifer+Hillier')));
  assert.ok(r.urls.some((u) => u.startsWith('https://itunes.apple.com/search?term=Heart+of+Glass+Jennifer+Hillier')));
});

test('covers: still retries a transient failure through the shared fetcher', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return calls === 1 ? { ok: false, status: 503, headers: { get: () => null } } : { ok: true, status: 200, json: async () => ({ ok: 1 }) }; };
  assert.deepEqual(await catalog.fetchJson('https://x', { fetchImpl, sleepImpl: async () => {} }), { ok: 1 });
  assert.equal(calls, 2);
});

test('googleBooksUrl: no key → no key param', () => {
  const prev = process.env.GOOGLE_BOOKS_API_KEY;
  delete process.env.GOOGLE_BOOKS_API_KEY;
  try {
    assert.equal(catalog.googleBooksUrl('a b', { maxResults: 5 }), 'https://www.googleapis.com/books/v1/volumes?q=a%20b&maxResults=5&country=US');
  } finally {
    if (prev !== undefined) process.env.GOOGLE_BOOKS_API_KEY = prev;
  }
});
