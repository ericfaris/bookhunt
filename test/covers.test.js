'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  lookupCover,
  resolveCover,
  coverFromOpenLibrary,
  coverFromGoogleBooks,
  openLibraryCoverUrl,
  cacheKey,
} = require('../src/covers');

// A fetch stub: maps a substring of the URL to a JSON payload (or an error).
function stubFetch(routes) {
  return async (url) => {
    for (const [needle, val] of routes) {
      if (url.includes(needle)) {
        if (val instanceof Error) throw val;
        return { ok: true, status: 200, json: async () => val };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

// An in-memory cache matching the { get, set } shape resolveCover expects.
function memCache() {
  const store = new Map();
  return {
    store,
    get: (k) => store.get(k) || null,
    set: (k, v) => store.set(k, v),
  };
}

test('coverFromOpenLibrary: builds a covers.openlibrary.org URL from cover_i', () => {
  const url = coverFromOpenLibrary({ docs: [{ cover_i: 8231856 }] });
  assert.equal(url, 'https://covers.openlibrary.org/b/id/8231856-M.jpg');
});

test('coverFromOpenLibrary: skips docs without a numeric cover_i, returns null when none', () => {
  assert.equal(coverFromOpenLibrary({ docs: [{}, { cover_i: null }] }), null);
  assert.equal(coverFromOpenLibrary({ docs: [{ title: 'x' }, { cover_i: 42 }] }),
    openLibraryCoverUrl(42));
  assert.equal(coverFromOpenLibrary({}), null);
  assert.equal(coverFromOpenLibrary(null), null);
});

test('coverFromGoogleBooks: prefers thumbnail and upgrades http→https', () => {
  const url = coverFromGoogleBooks({
    items: [{ volumeInfo: { imageLinks: { smallThumbnail: 'http://x/s.jpg', thumbnail: 'http://x/t.jpg' } } }],
  });
  assert.equal(url, 'https://x/t.jpg');
});

test('coverFromGoogleBooks: falls back to smallThumbnail, null when no images', () => {
  assert.equal(
    coverFromGoogleBooks({ items: [{ volumeInfo: { imageLinks: { smallThumbnail: 'https://x/s.jpg' } } }] }),
    'https://x/s.jpg'
  );
  assert.equal(coverFromGoogleBooks({ items: [{ volumeInfo: {} }] }), null);
  assert.equal(coverFromGoogleBooks({}), null);
});

test('lookupCover: returns the Open Library cover when present (no Google call)', async () => {
  const cover = await lookupCover(
    { title: 'Dune', author: 'Herbert' },
    { fetchImpl: stubFetch([['openlibrary.org', { docs: [{ cover_i: 11 }] }]]) }
  );
  assert.equal(cover, openLibraryCoverUrl(11));
});

test('lookupCover: falls through to Google Books when Open Library has no cover', async () => {
  const cover = await lookupCover(
    { title: 'Dune', author: 'Herbert' },
    {
      fetchImpl: stubFetch([
        ['openlibrary.org', { docs: [{}] }], // no cover_i
        ['googleapis.com', { items: [{ volumeInfo: { imageLinks: { thumbnail: 'https://g/t.jpg' } } }] }],
      ]),
    }
  );
  assert.equal(cover, 'https://g/t.jpg');
});

test('lookupCover: Open Library error falls through to Google Books (fail-soft)', async () => {
  const cover = await lookupCover(
    { title: 'Dune' },
    {
      fetchImpl: stubFetch([
        ['openlibrary.org', new Error('boom')],
        ['googleapis.com', { items: [{ volumeInfo: { imageLinks: { thumbnail: 'https://g/t.jpg' } } }] }],
      ]),
    }
  );
  assert.equal(cover, 'https://g/t.jpg');
});

test('lookupCover: returns null when both sources miss, never throws', async () => {
  const cover = await lookupCover(
    { title: 'Nothing' },
    { fetchImpl: stubFetch([['openlibrary.org', new Error('x')], ['googleapis.com', new Error('y')]]) }
  );
  assert.equal(cover, null);
});

test('lookupCover: empty title and author short-circuits to null', async () => {
  let called = false;
  await lookupCover({ title: '', author: '' }, { fetchImpl: async () => { called = true; } });
  assert.equal(called, false);
});

test('resolveCover: caches a positive result and serves it without re-lookup', async () => {
  const cache = memCache();
  let calls = 0;
  const lookup = async () => { calls++; return 'https://c/1.jpg'; };

  const first = await resolveCover({ title: 'Dune', author: 'Herbert' }, { cache, lookup });
  const second = await resolveCover({ title: 'Dune', author: 'Herbert' }, { cache, lookup });

  assert.equal(first, 'https://c/1.jpg');
  assert.equal(second, 'https://c/1.jpg');
  assert.equal(calls, 1, 'second call served from cache');
  assert.deepEqual(cache.get(cacheKey({ title: 'Dune', author: 'Herbert' })).cover, 'https://c/1.jpg');
});

test('resolveCover: caches a negative and does not re-query while fresh', async () => {
  const cache = memCache();
  let calls = 0;
  const lookup = async () => { calls++; return null; };

  const now = 1_000_000;
  const a = await resolveCover({ title: 'Ghost' }, { cache, lookup, now });
  const b = await resolveCover({ title: 'Ghost' }, { cache, lookup, now: now + 1000 });

  assert.equal(a, null);
  assert.equal(b, null);
  assert.equal(calls, 1, 'fresh negative is not re-queried');
});

test('resolveCover: re-queries a stale negative (past the TTL)', async () => {
  const cache = memCache();
  let calls = 0;
  const lookup = async () => { calls++; return calls === 1 ? null : 'https://late/cover.jpg'; };

  const now = 1_000_000;
  const a = await resolveCover({ title: 'Late' }, { cache, lookup, now });
  // 8 days later — past the 7-day negative TTL.
  const later = now + 8 * 24 * 60 * 60 * 1000;
  const b = await resolveCover({ title: 'Late' }, { cache, lookup, now: later });

  assert.equal(a, null);
  assert.equal(b, 'https://late/cover.jpg', 'stale negative re-looked-up and now found');
  assert.equal(calls, 2);
});

test('resolveCover: a lookup that throws resolves to null and is cached negative', async () => {
  const cache = memCache();
  const lookup = async () => { throw new Error('boom'); };
  const out = await resolveCover({ title: 'Boom' }, { cache, lookup });
  assert.equal(out, null);
  assert.equal(cache.get(cacheKey({ title: 'Boom', author: '' })).cover, null);
});

test('resolveCover: empty title+author returns null without consulting cache/lookup', async () => {
  let touched = false;
  const cache = { get: () => { touched = true; return null; }, set: () => { touched = true; } };
  const out = await resolveCover({ title: '', author: '' }, { cache, lookup: async () => 'x' });
  assert.equal(out, null);
  assert.equal(touched, false);
});

test('cacheKey: case- and punctuation-insensitive', () => {
  assert.equal(cacheKey({ title: 'J.K. Rowling!', author: '' }), cacheKey({ title: 'j k rowling', author: '' }));
});
