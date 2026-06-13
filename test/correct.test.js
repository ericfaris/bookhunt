'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  correct,
  reconcile,
  correctedField,
  normalize,
  similarity,
  matchScore,
  pickBest,
  defaultLookup,
  lookupGoogleBooks,
  combinedScore,
} = require('../src/correct');

// --- normalize / similarity -------------------------------------------------

test('normalize: folds case and punctuation', () => {
  assert.equal(normalize('J.K. Rowling'), 'j k rowling');
  assert.equal(normalize('  The   Hobbit!! '), 'the hobbit');
  assert.equal(normalize(''), '');
});

test('similarity: identical strings score 1, disjoint score low', () => {
  assert.equal(similarity('dune', 'dune'), 1);
  assert.ok(similarity('harry potter', 'hary poter') > 0.8);
  assert.ok(similarity('dune', 'the hobbit') < 0.4);
});

// --- matchScore / pickBest (best-of-N candidate selection) ------------------

test('matchScore: prefix and full matches score high, junk scores low', () => {
  assert.ok(matchScore('The Great Gatsbi', 'The Great Gatsby') > 0.9);
  assert.ok(matchScore('Hary Poter', 'Harry Potter and the Sorcerer\'s Stone') > 0.8);
  assert.ok(matchScore('The Great Gatsbi', 'F. Scott Fitzgerald: The Great Gatsby') < 0.5);
});

test('pickBest: chooses the closest title, not the first hit', () => {
  // Mirrors Google\'s real "The Great Gatsbi" results: an author-prefixed edition
  // comes back first, the clean title second.
  const list = [
    { t: 'F. Scott Fitzgerald: The Great Gatsby' },
    { t: 'The Great Gatsby' },
    { t: 'The Great Gatsby by F. Scott Fitzgerald' },
  ];
  assert.equal(pickBest('The Great Gatsbi', list, (x) => x.t).t, 'The Great Gatsby');
});

test('pickBest: with no title to score, keeps the first element', () => {
  const list = [{ t: 'A' }, { t: 'B' }];
  assert.equal(pickBest('', list, (x) => x.t).t, 'A');
  assert.equal(pickBest('x', [], (x) => x.t), null);
});

test('lookupGoogleBooks: picks the best-matching item, not items[0]', async () => {
  const fetchImpl = async () =>
    fakeRes(200, {
      items: [
        { volumeInfo: { title: 'F. Scott Fitzgerald: The Great Gatsby', authors: ['F. Scott Fitzgerald'] } },
        { volumeInfo: { title: 'The Great Gatsby', authors: ['Francis Scott Fitzgerald'] } },
      ],
    });
  const c = await lookupGoogleBooks({ title: 'The Great Gatsbi', author: '' }, { fetchImpl });
  assert.equal(c.title, 'The Great Gatsby');
  assert.equal(c.source, 'google-books');
});

// --- candidate variants: junk tails dropped, real words kept ----------------

test('correctedField: drops a trailing edition/language parenthetical', () => {
  assert.equal(correctedField('Atomik Habit', 'Atomic Habits (Tamil)'), 'Atomic Habits');
});

test('correctedField: drops a trailing series number', () => {
  assert.equal(
    correctedField('A Court of Thorn and Rose', 'A Court of Thorns and Roses 7'),
    'A Court of Thorns and Roses'
  );
});

test('correctedField: keeps a number that is part of the title (no over-trim)', () => {
  // "Fahrenheit 451" must NOT collapse to "Fahrenheit" — the full form matches
  // the typed term better, so it wins.
  assert.equal(correctedField('Farenheit 451', 'Fahrenheit 451'), 'Fahrenheit 451');
});

test('correctedField: preserves a legitimately longer title (mid-word omission)', () => {
  // The user dropped an interior word; the candidate is correctly longer, so the
  // full form must survive (with corroboration loosening the gate to 0.6).
  assert.equal(correctedField('It Ends Us', 'It Ends with Us', 0.6), 'It Ends with Us');
  assert.equal(correctedField('The God of Woods', 'The God of the Woods', 0.6), 'The God of the Woods');
});

// --- correctedField (the per-field gate) ------------------------------------

test('correctedField: fixes a close typo', () => {
  assert.equal(correctedField('Hary Poter', 'Harry Potter'), 'Harry Potter');
  assert.equal(correctedField('J.K. Rowlng', 'J.K. Rowling'), 'J.K. Rowling');
});

test('correctedField: identical (ignoring case/punct) keeps the original verbatim', () => {
  assert.equal(correctedField('harry potter', 'Harry Potter'), 'harry potter');
  assert.equal(correctedField('J.K. Rowling', 'J. K. Rowling'), 'J.K. Rowling');
});

test('correctedField: never fills a blank field', () => {
  assert.equal(correctedField('', 'Some Author'), '');
});

test('correctedField: a wrong-book candidate leaves the input untouched', () => {
  assert.equal(correctedField('Dune', 'The Hobbit'), 'Dune');
});

test('correctedField: a longer canonical title collapses to the typed-length prefix', () => {
  // Google often returns the full title; the leading tokens should match the typo.
  assert.equal(
    correctedField('Hary Poter', "Harry Potter and the Sorcerer's Stone"),
    'Harry Potter'
  );
});

test('correctedField: a case-only re-cased prefix is NOT treated as a correction', () => {
  // Correctly spelled (just lowercase) against a longer canonical title — the
  // leading tokens only differ in case, so keep the original (no noise).
  assert.equal(
    correctedField('harry potter', "Harry Potter and the Half-Blood Prince"),
    'harry potter'
  );
});

// --- reconcile --------------------------------------------------------------

test('reconcile: flags corrected when either field changes', () => {
  const out = reconcile(
    { title: 'Hary Poter', author: 'J.K. Rowlng' },
    { title: 'Harry Potter', author: 'J.K. Rowling', source: 'google-books' }
  );
  assert.equal(out.corrected, true);
  assert.equal(out.title, 'Harry Potter');
  assert.equal(out.author, 'J.K. Rowling');
  assert.deepEqual(out.original, { title: 'Hary Poter', author: 'J.K. Rowlng' });
  assert.equal(out.source, 'google-books');
});

test('reconcile: a good query is not flagged as corrected', () => {
  const out = reconcile(
    { title: 'Dune', author: 'Frank Herbert' },
    { title: 'Dune', author: 'Frank Herbert' }
  );
  assert.equal(out.corrected, false);
});

test('reconcile: a null candidate passes the original through', () => {
  const out = reconcile({ title: 'Dune', author: '' }, null);
  assert.equal(out.corrected, false);
  assert.equal(out.title, 'Dune');
});

test('reconcile: an exact author match corroborates a borderline title fix', () => {
  // "Mad Maple" → "Mad Mabel" is ratio ≈ 0.67 (under 0.7 standalone), but the
  // exact author match confirms the book, so the title is still corrected.
  const out = reconcile(
    { title: 'Mad Maple', author: 'Sally Hepworth' },
    { title: 'Mad Mabel', author: 'Sally Hepworth' }
  );
  assert.equal(out.corrected, true);
  assert.equal(out.title, 'Mad Mabel');
  assert.equal(out.author, 'Sally Hepworth');
});

test('reconcile: WITHOUT corroboration a borderline title fix is rejected', () => {
  // Same title edit, but no author given → nothing corroborates → 0.67 < 0.7,
  // so the typed term is left untouched (guards against wrong-book matches).
  const out = reconcile({ title: 'Mad Maple', author: '' }, { title: 'Mad Mabel', author: '' });
  assert.equal(out.corrected, false);
  assert.equal(out.title, 'Mad Maple');
});

test('reconcile: corroboration does NOT pull in a genuinely different title', () => {
  // Exact author, but a wildly different title (ratio well under 0.5) must NOT
  // be "corrected" just because the author matches.
  const out = reconcile(
    { title: 'Dune', author: 'Frank Herbert' },
    { title: 'The Santaroga Barrier', author: 'Frank Herbert' }
  );
  assert.equal(out.corrected, false);
  assert.equal(out.title, 'Dune');
});

// --- correct (async orchestration, injected lookup) -------------------------

test('correct: applies a high-confidence correction', async () => {
  const out = await correct(
    { title: 'Hary Poter', author: 'J.K. Rowlng' },
    { lookup: async () => ({ title: 'Harry Potter', author: 'J.K. Rowling' }) }
  );
  assert.equal(out.corrected, true);
  assert.equal(out.title, 'Harry Potter');
  assert.equal(out.author, 'J.K. Rowling');
});

test('correct: a correctly-spelled query is a no-op (no notice)', async () => {
  const out = await correct(
    { title: 'Dune', author: 'Frank Herbert' },
    { lookup: async () => ({ title: 'Dune', author: 'Frank Herbert' }) }
  );
  assert.equal(out.corrected, false);
  assert.equal(out.title, 'Dune');
  assert.equal(out.author, 'Frank Herbert');
});

test('correct: fails open when the lookup throws', async () => {
  const out = await correct(
    { title: 'Hary Poter', author: '' },
    { lookup: async () => { throw new Error('network down'); } }
  );
  assert.equal(out.corrected, false);
  assert.equal(out.title, 'Hary Poter');
});

test('correct: fails open when the lookup times out / aborts', async () => {
  const out = await correct(
    { title: 'Hary Poter', author: '' },
    {
      lookup: () =>
        new Promise((_resolve, reject) => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        }),
    }
  );
  assert.equal(out.corrected, false);
  assert.equal(out.title, 'Hary Poter');
});

test('correct: empty input is a no-op without calling the lookup', async () => {
  let called = false;
  const out = await correct(
    { title: '', author: '' },
    { lookup: async () => { called = true; return { title: 'x', author: 'y' }; } }
  );
  assert.equal(called, false);
  assert.equal(out.corrected, false);
});

test('correct: tolerates non-string / missing input', async () => {
  const out = await correct(undefined, { lookup: async () => null });
  assert.equal(out.corrected, false);
  assert.equal(out.title, '');
  assert.equal(out.author, '');
});

test('correct: candidate.source flows through to the result', async () => {
  const out = await correct(
    { title: 'Hary Poter', author: '' },
    { lookup: async () => ({ title: 'Harry Potter', author: '', source: 'open-library' }) }
  );
  assert.equal(out.corrected, true);
  assert.equal(out.source, 'open-library');
});

// --- defaultLookup source chain (mocked fetch) ------------------------------

function fakeRes(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('defaultLookup: falls back to Open Library when Google Books fails', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('googleapis.com')) return fakeRes(429, {}); // quota exhausted
    return fakeRes(200, { docs: [{ title: 'Harry Potter', author_name: ['J. K. Rowling'] }] });
  };
  const c = await defaultLookup({ title: 'Hary Poter', author: '' }, { fetchImpl });
  assert.equal(c.title, 'Harry Potter');
  assert.equal(c.author, 'J. K. Rowling');
  assert.equal(c.source, 'open-library');
});

test('defaultLookup: prefers Google Books when it answers', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('googleapis.com')) {
      return fakeRes(200, { items: [{ volumeInfo: { title: 'Dune', authors: ['Frank Herbert'] } }] });
    }
    throw new Error('should not reach Open Library');
  };
  const c = await defaultLookup({ title: 'Dune', author: '' }, { fetchImpl });
  assert.equal(c.title, 'Dune');
  assert.equal(c.source, 'google-books');
});

test('defaultLookup: returns null when every source fails (→ fail open)', async () => {
  const fetchImpl = async () => fakeRes(500, {});
  assert.equal(await defaultLookup({ title: 'X', author: '' }, { fetchImpl }), null);
});

test('defaultLookup: picks the source whose candidate matches BOTH fields best', async () => {
  // Google returns a wrong-but-present book; Open Library returns the right one.
  // Querying both (not stopping at Google) lets the better answer win.
  const fetchImpl = async (url) => {
    if (url.includes('googleapis.com')) {
      return fakeRes(200, { items: [{ volumeInfo: { title: 'Some Other Book', authors: ['Wrong Author'] } }] });
    }
    return fakeRes(200, { docs: [{ title: 'Iron Flame', author_name: ['Rebecca Yarros'] }] });
  };
  const c = await defaultLookup({ title: 'Iron Flames', author: 'Rebecka Yarros' }, { fetchImpl });
  assert.equal(c.title, 'Iron Flame');
  assert.equal(c.source, 'open-library');
});

// --- combinedScore ----------------------------------------------------------

test('combinedScore: averages the supplied fields; ignores blank ones', () => {
  const strong = combinedScore({ title: 'Iron Flames', author: 'Rebecka Yarros' }, { title: 'Iron Flame', author: 'Rebecca Yarros' });
  const weak = combinedScore({ title: 'Iron Flames', author: 'Rebecka Yarros' }, { title: 'Cooking 101', author: 'Nobody' });
  assert.ok(strong > 0.8 && strong > weak);
  // title-only request → author not factored in
  assert.equal(combinedScore({ title: 'Dune', author: '' }, { title: 'Dune', author: 'Whoever' }), 1);
});

// --- end-to-end reconcile: both fields misspelled ---------------------------

test('reconcile: corrects BOTH fields when each corroborates the other', () => {
  const out = reconcile(
    { title: 'Atomik Habit', author: 'James Cleer' },
    { title: 'Atomic Habits (Tamil)', author: 'James Clear' }
  );
  assert.equal(out.corrected, true);
  assert.equal(out.title, 'Atomic Habits');
  assert.equal(out.author, 'James Clear');
});
