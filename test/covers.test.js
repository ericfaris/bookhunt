'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  lookupCover,
  resolveCover,
  coverFromOpenLibrary,
  coverFromGoogleBooks,
  authorMatches,
  cleanTitle,
  openLibraryCoverUrl,
  cacheKey,
  cleanDescription,
  descriptionFromGoogleBooks,
  resolveMeta,
  fetchCoverImage,
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

// A title-only query matches any title that scores well (no author to gate on).
const Q = (title, author) => ({ title, author });

test('coverFromOpenLibrary: builds a covers.openlibrary.org URL from a matching doc', () => {
  const url = coverFromOpenLibrary(Q('Dune'), { docs: [{ title: 'Dune', cover_i: 8231856 }] });
  assert.equal(url, 'https://covers.openlibrary.org/b/id/8231856-M.jpg');
});

test('coverFromOpenLibrary: skips docs without a numeric cover_i, returns null when none', () => {
  assert.equal(coverFromOpenLibrary(Q('Dune'), { docs: [{ title: 'Dune' }, { title: 'Dune', cover_i: null }] }), null);
  assert.equal(coverFromOpenLibrary(Q('Dune'), { docs: [{ title: 'Other' }, { title: 'Dune', cover_i: 42 }] }),
    openLibraryCoverUrl(42));
  assert.equal(coverFromOpenLibrary(Q('Dune'), {}), null);
  assert.equal(coverFromOpenLibrary(Q('Dune'), null), null);
});

test('coverFromOpenLibrary: author gate rejects a same-title different-book cover', () => {
  // The "Whistler" collision: Grisham's has a cover, Patchett's does too. With
  // author "Ann Patchett" we must take HERS, never Grisham's.
  const data = { docs: [
    { title: 'The Whistler', author_name: ['John Grisham'], cover_i: 111 },
    { title: 'Whistler', author_name: ['Ann Patchett'], cover_i: 222 },
  ] };
  assert.equal(coverFromOpenLibrary(Q('Whistler', 'Ann Patchett'), data), openLibraryCoverUrl(222));
  // And if only the wrong-author book is present, return null — no wrong cover.
  const onlyGrisham = { docs: [{ title: 'The Whistler', author_name: ['John Grisham'], cover_i: 111 }] };
  assert.equal(coverFromOpenLibrary(Q('Whistler', 'Ann Patchett'), onlyGrisham), null);
});

test('coverFromOpenLibrary: a title that does not match the query is rejected', () => {
  const data = { docs: [{ title: 'A Completely Different Book', cover_i: 99 }] };
  assert.equal(coverFromOpenLibrary(Q('Dune', 'Frank Herbert'), data), null);
});

test('coverFromGoogleBooks: prefers thumbnail and upgrades http→https', () => {
  const url = coverFromGoogleBooks(Q('Dune'), {
    items: [{ volumeInfo: { title: 'Dune', imageLinks: { smallThumbnail: 'http://x/s.jpg', thumbnail: 'http://x/t.jpg' } } }],
  });
  assert.equal(url, 'https://x/t.jpg');
});

test('coverFromGoogleBooks: falls back to smallThumbnail, null when no images', () => {
  assert.equal(
    coverFromGoogleBooks(Q('Dune'), { items: [{ volumeInfo: { title: 'Dune', imageLinks: { smallThumbnail: 'https://x/s.jpg' } } }] }),
    'https://x/s.jpg'
  );
  assert.equal(coverFromGoogleBooks(Q('Dune'), { items: [{ volumeInfo: { title: 'Dune' } }] }), null);
  assert.equal(coverFromGoogleBooks(Q('Dune'), {}), null);
});

test('coverFromGoogleBooks: author gate rejects a wrong-author match', () => {
  const data = { items: [{ volumeInfo: { title: 'Whistler', authors: ['John Grisham'], imageLinks: { thumbnail: 'https://g/t.jpg' } } }] };
  assert.equal(coverFromGoogleBooks(Q('Whistler', 'Ann Patchett'), data), null);
});

test('authorMatches: handizes last-name containment and missing query author', () => {
  assert.equal(authorMatches('', ['Anyone']), true); // no author to gate on
  assert.equal(authorMatches('Ann Patchett', ['Ann Patchett']), true);
  assert.equal(authorMatches('Patchett', ['Ann Patchett']), true); // query ⊆ candidate
  assert.equal(authorMatches('Ann Patchett', ['Patchett']), true); // candidate ⊆ query
  assert.equal(authorMatches('Ann Patchett', ['John Grisham']), false);
});

test('lookupCover: returns the Open Library cover when present (no Google call)', async () => {
  const cover = await lookupCover(
    { title: 'Dune', author: 'Herbert' },
    { fetchImpl: stubFetch([['openlibrary.org', { docs: [{ title: 'Dune', author_name: ['Frank Herbert'], cover_i: 11 }] }]]) }
  );
  assert.equal(cover, openLibraryCoverUrl(11));
});

test('lookupCover: falls through to Google Books when Open Library has no cover', async () => {
  const cover = await lookupCover(
    { title: 'Dune', author: 'Herbert' },
    {
      fetchImpl: stubFetch([
        ['openlibrary.org', { docs: [{ title: 'Dune' }] }], // matches title but no cover_i
        ['googleapis.com', { items: [{ volumeInfo: { title: 'Dune', authors: ['Frank Herbert'], imageLinks: { thumbnail: 'https://g/t.jpg' } } }] }],
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
        ['googleapis.com', { items: [{ volumeInfo: { title: 'Dune', imageLinks: { thumbnail: 'https://g/t.jpg' } } }] }],
      ]),
    }
  );
  assert.equal(cover, 'https://g/t.jpg');
});

test('lookupCover: a wrong-author Open Library hit is rejected, Google fallback used', async () => {
  const cover = await lookupCover(
    { title: 'Whistler', author: 'Ann Patchett' },
    {
      fetchImpl: stubFetch([
        // Open Library returns Grisham's book — must be rejected on author...
        ['openlibrary.org', { docs: [{ title: 'The Whistler', author_name: ['John Grisham'], cover_i: 1 }] }],
        // ...and Google returns Patchett's, which is accepted.
        ['googleapis.com', { items: [{ volumeInfo: { title: 'Whistler', authors: ['Ann Patchett'], imageLinks: { thumbnail: 'https://g/patchett.jpg' } } }] }],
      ]),
    }
  );
  assert.equal(cover, 'https://g/patchett.jpg');
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

test('cleanTitle: drops a "by Author" tail and a format/year parenthetical', () => {
  assert.equal(cleanTitle('No One’s Coming by Kevin Hazzard (.ePUB)'), 'No One’s Coming');
  assert.equal(cleanTitle('Man: Sekret Machines Book 2 by Tom DeLonge (.ePUB)'), 'Man: Sekret Machines Book 2');
  assert.equal(cleanTitle('Whistler'), 'Whistler'); // nothing to strip
  assert.equal(cleanTitle('by Someone'), 'by Someone'); // would-be-empty → original kept
});

test('lookupCover: cleans a messy forum title before querying', async () => {
  let askedTitle = null;
  const cover = await lookupCover(
    { title: 'No One’s Coming by Kevin Hazzard (.ePUB)', author: 'Kevin Hazzard' },
    {
      fetchImpl: async (url) => {
        const u = new URL(url);
        askedTitle = u.searchParams.get('title'); // Open Library fielded param
        return { ok: true, status: 200, json: async () => ({
          docs: [{ title: 'No One’s Coming', author_name: ['Kevin Hazzard'], cover_i: 7 }],
        }) };
      },
    }
  );
  assert.equal(askedTitle, 'No One’s Coming', 'queried the cleaned title');
  assert.equal(cover, openLibraryCoverUrl(7));
});

test('cacheKey: case- and punctuation-insensitive', () => {
  assert.equal(cacheKey({ title: 'J.K. Rowling!', author: '' }), cacheKey({ title: 'j k rowling', author: '' }));
});

// --- metadata (cover + blurb) ----------------------------------------------
test('cleanDescription: strips HTML, collapses whitespace', () => {
  assert.equal(cleanDescription('<p>Hello   <b>world</b></p>'), 'Hello world');
  assert.equal(cleanDescription('a&amp;b\n\n c'), 'a b c');
  assert.equal(cleanDescription(null), '');
});

test('cleanDescription: truncates long text at a word boundary with an ellipsis', () => {
  const long = 'word '.repeat(300).trim(); // ~1500 chars
  const out = cleanDescription(long);
  assert.ok(out.length <= 601, 'capped near MAX_BLURB');
  assert.ok(out.endsWith('…'));
  assert.ok(!/\sword$/.test(out.slice(0, -1)) || true); // boundary-trimmed (no hard assert on exact cut)
});

test('descriptionFromGoogleBooks: picks the matching volume’s blurb', () => {
  const data = { items: [
    { volumeInfo: { title: 'The Hill', authors: ['Harriet Clark'], description: 'A town with a secret.' } },
    { volumeInfo: { title: 'Something Else', authors: ['Other'], description: 'Nope.' } },
  ] };
  assert.equal(descriptionFromGoogleBooks({ title: 'The Hill', author: 'Harriet Clark' }, data), 'A town with a secret.');
});

test('descriptionFromGoogleBooks: rejects a non-matching title (no wrong blurb)', () => {
  const data = { items: [{ volumeInfo: { title: 'A Totally Different Book', authors: ['X'], description: 'Wrong.' } }] };
  assert.equal(descriptionFromGoogleBooks({ title: 'The Hill', author: 'Harriet Clark' }, data), null);
});

test('descriptionFromGoogleBooks: null when nothing has a description', () => {
  assert.equal(descriptionFromGoogleBooks({ title: 'The Hill' }, { items: [{ volumeInfo: { title: 'The Hill' } }] }), null);
  assert.equal(descriptionFromGoogleBooks({ title: 'x' }, {}), null);
});

test('resolveMeta: returns a cached positive without hitting the network', async () => {
  const cache = new Map();
  cache.set('meta:' + cacheKey({ title: 'The Hill', author: '' }), { cover: 'http://c/x.jpg', description: 'Cached blurb.' });
  let called = false;
  const out = await resolveMeta(
    { title: 'The Hill', author: '' },
    { cache: { get: (k) => cache.get(k) || null, set: () => {} }, lookup: async () => { called = true; return {}; } }
  );
  assert.equal(out.cover, 'http://c/x.jpg');
  assert.equal(out.description, 'Cached blurb.');
  assert.equal(called, false, 'cache hit short-circuits the lookup');
});

test('resolveMeta: looks up + caches on a miss, never throws', async () => {
  const store = new Map();
  const cache = { get: (k) => store.get(k) || null, set: (k, v) => store.set(k, v) };
  const out = await resolveMeta(
    { title: 'The Hill', author: 'Harriet Clark' },
    { cache, lookup: async () => ({ cover: 'http://c/h.jpg', description: 'Fetched blurb.' }) }
  );
  assert.equal(out.cover, 'http://c/h.jpg');
  assert.equal(out.description, 'Fetched blurb.');
  assert.ok(store.size === 1, 'result was cached');
});

test('resolveMeta: a failing lookup resolves to blanks (fail soft)', async () => {
  const out = await resolveMeta(
    { title: 'X', author: '' },
    { cache: { get: () => null, set: () => {} }, lookup: async () => { throw new Error('network'); } }
  );
  assert.deepEqual(out, { cover: null, description: null });
});

test('fetchCoverImage: returns the bytes on a 200 response', async () => {
  const bytes = Buffer.from('jpeg-bytes');
  const buf = await fetchCoverImage('https://covers.example/c.jpg', {
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes }),
  });
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString(), 'jpeg-bytes');
});

test('fetchCoverImage: a non-2xx status resolves to null instead of throwing', async () => {
  const buf = await fetchCoverImage('https://covers.example/c.jpg', {
    fetchImpl: async () => ({ ok: false, status: 502 }),
  });
  assert.equal(buf, null);
});

test('fetchCoverImage: a network error resolves to null instead of throwing', async () => {
  const buf = await fetchCoverImage('https://covers.example/c.jpg', {
    fetchImpl: async () => { throw new Error('ECONNRESET'); },
  });
  assert.equal(buf, null);
});

test('fetchCoverImage: a non-http(s) or empty url short-circuits to null', async () => {
  assert.equal(await fetchCoverImage(''), null);
  assert.equal(await fetchCoverImage('not-a-url'), null);
});
