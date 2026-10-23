'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { normalize, fuzzyMatch, fuzzyMatchLine, isCollection, bylineMismatch, authorKeywords, titleKeywords, titleDeclaresNonEpub, titleLooksLikeAudiobook, collectionResult } = require('../src/searcher');

test('normalize: lowercases, strips punctuation, collapses space', () => {
  assert.equal(normalize('1984: Illustrated!'), '1984 illustrated');
  assert.equal(normalize('  The   Hobbit  '), 'the hobbit');
  assert.equal(normalize(''), '');
  assert.equal(normalize(null), '');
});

test('normalize: folds accents, &, apostrophes and initials', () => {
  assert.equal(normalize('Zoë Bäckman'), 'zoe backman');
  assert.equal(normalize('Pride & Prejudice'), 'pride and prejudice');
  assert.equal(normalize('Hell\u2019s Kitchen'), 'hells kitchen');
  assert.equal(normalize("Hell's Kitchen"), 'hells kitchen');
  assert.equal(normalize('J.D. Robb'), 'jd robb');
  assert.equal(normalize('J. D. Robb'), 'jd robb');
  assert.equal(normalize('J.R.R. Tolkien'), 'jrr tolkien');
  // a lone single letter is NOT merged into its neighbours
  assert.equal(normalize('A Map to Murder'), 'a map to murder');
  assert.equal(normalize('I, Robot'), 'i robot');
  assert.equal(normalize('Heart of Glass (.ePUB)'), 'heart of glass epub');
});

test('fuzzyMatch: spelling variants between catalog and forum titles match', () => {
  const pairs = [
    ['J.D. Robb', 'Payback in Death by JD Robb (.ePUB)'],
    ['JD Robb', 'Payback in Death by J. D. Robb (.ePUB)'],
    ['Zoe Sugg', 'Girl Online by Zoë Sugg'],
    ['Zoë Sugg', 'Girl Online by Zoe Sugg'],
    ['Pride and Prejudice', 'Pride & Prejudice by Jane Austen'],
    ['Pride & Prejudice', 'Pride and Prejudice by Jane Austen'],
    ["Hell's Kitchen", 'Hells Kitchen by Someone'],
    ['Hells Kitchen', 'Hell\u2019s Kitchen by Someone'],
    // co-authors: list says "and", forum says "&" or ","
    ['Elin Hilderbrand and Shelby Cunningham', 'The Academy series by Elin Hilderbrand & Shelby Cunningham (.ePUB)'],
    ['Elin Hilderbrand and Shelby Cunningham', 'Elin Hilderbrand, Shelby Cunningham'],
    ['Elin Hilderbrand & Shelby Cunningham', 'Elin Hilderbrand, Shelby Cunningham'],
  ];
  for (const [q, t] of pairs) assert.equal(fuzzyMatch(q, t), true, `${q} ⇢ ${t}`);
  // ignoring "and" must not drop the real name tokens
  assert.equal(fuzzyMatch('Elin Hilderbrand and Shelby Cunningham', 'Elin Hilderbrand'), false);
  // folding must not loosen the word-start rule
  assert.equal(fuzzyMatch('it ends with us', 'Loving with Demons by Hana Mahmood'), false);
  assert.equal(fuzzyMatch('J.D. Robb', 'Jane Doe Robbins'), false);
});

test('fuzzyMatch: every query token must appear in target', () => {
  assert.equal(fuzzyMatch('1984', '1984: Illustrated Edition'), true);
  assert.equal(fuzzyMatch('george orwell', 'Orwell, George'), true); // order-independent
  assert.equal(fuzzyMatch('hobbit', 'The Lord of the Rings'), false);
  assert.equal(fuzzyMatch('', 'anything'), true); // empty query matches
});

test('fuzzyMatch: tokens match at word starts, not mid-word substrings', () => {
  // prefix/stem matches still work
  assert.equal(fuzzyMatch('demon', 'Loving with Demons'), true);
  // short tokens must NOT match inside unrelated words: "it"/"us" should not be
  // found inside "with"/"trust". This is the "It Ends with Us" false positive.
  assert.equal(
    fuzzyMatch('it ends with us', 'Loving with Demons by Hana Mahmood'),
    false
  );
  // a genuine match still passes
  assert.equal(fuzzyMatch('it ends with us', 'It Ends with Us (.ePUB)'), true);
});

test('fuzzyMatchLine: comp-title blurb mention does not satisfy a real title', () => {
  // A "for fans of" line literally naming the title+author is the trap; the
  // title-token check below should not be fooled by short tokens scattered
  // across ordinary prose.
  const blurb = 'A dark romance about trust and demons without an easy ending.';
  assert.equal(fuzzyMatchLine('it ends with us', blurb), false);
});

test('fuzzyMatchLine: all tokens must share one line', () => {
  const text = 'Animal Farm\n1984 by George Orwell\nBrave New World';
  assert.equal(fuzzyMatchLine('george orwell', text), true);
  // tokens split across different lines should NOT match
  assert.equal(fuzzyMatchLine('animal orwell', text), false);
});

test('isCollection: detects bundle/series keywords (incl. "&")', () => {
  assert.equal(isCollection('The Complete Works of Shakespeare'), true);
  assert.equal(isCollection('Animal Farm & 1984'), true);
  assert.equal(isCollection('Animal Farm & 1984 by George Orwell', 'Animal Farm'), true);
  assert.equal(isCollection('Dune Omnibus'), true);
  assert.equal(isCollection('1984'), false);
});

test('isCollection: detects counted/"books by"/box-set posts without a keyword', () => {
  // Regression: this set held "Heart of Glass" but was skipped unopened.
  assert.equal(isCollection('4 Novels by Jennifer Hillier (.ePUB)'), true);
  assert.equal(isCollection('Books by Sally Hepworth (.ePUB)'), true);
  assert.equal(isCollection('Creep, Books 1-2 by Jennifer Hillier (.ePUB)'), true);
  assert.equal(isCollection('12 Books by Lee Child'), true);
  assert.equal(isCollection('Bridgerton Box Set by Julia Quinn'), true);
  assert.equal(isCollection('Reacher Boxset'), true);
  assert.equal(isCollection('Mystery Bundle (.ePUB)'), true);
  // Ordinary single-book titles must stay single.
  assert.equal(isCollection('Heart of Glass by Jennifer Hillier (.ePUB)'), false);
  assert.equal(isCollection('The Book Thief by Markus Zusak (.ePUB)'), false);
  assert.equal(isCollection('The Books of Jacob by Olga Tokarczuk'), false);
  assert.equal(isCollection('Novel Ideas by Jane Doe'), false);
  assert.equal(isCollection('The Bookshop by Penelope Fitzgerald'), false);
  assert.equal(isCollection('Catch-22 by Joseph Heller'), false);
});

test('isCollection: series/volume ranges, packs and anthologies', () => {
  for (const t of [
    'The Hunger Games Trilogy by Suzanne Collins',
    'Shadow and Bone Duology',
    'The Raj Quartet',
    'Three Novels by Jennifer Hillier',
    'Five Books by Lee Child',
    'The Hillier Novels (.ePUB)',
    '12 Short Stories by Stephen King',
    'Dresden Files #1-5',
    'Dresden Files # 1 - 5',
    'Discworld Vol. 1-3',
    'Wheel of Time Volumes 1-4',
    'Mystery 3-in-1 (.ePUB)',
    'Romance Mega Pack',
    'Thriller eBook Pack',
    'Best American Anthology 2025',
    'A Christmas Treasury',
    'Lovecraft Compendium',
    'Harry Potter Boxed Set',
  ]) assert.equal(isCollection(t), true, t);
  for (const t of [
    'Wolf Pack by C.J. Box (.ePUB)',
    'Set in Stone by Jane Doe',
    'The Set-Up by Jane Doe',
    'Ghost Story by Jim Butcher',
    'Book 4 of Something',
    'Volume Control by Jane Doe',
    'The Novelist by Jane Doe',
    'Catch-22 by Joseph Heller',
    'Heart of Glass by Jennifer Hillier (.ePUB)',
  ]) assert.equal(isCollection(t), false, t);
});

test('titleDeclaresNonEpub: skips audiobook/PDF-only titles without opening them', () => {
  // Non-epub formats declared in the title → skip (the bug: these were opened).
  assert.equal(titleDeclaresNonEpub('Project Hail Mary by Andy Weir (.M4B)'), true);
  assert.equal(titleDeclaresNonEpub('Some Audiobook (.MP3)'), true);
  assert.equal(titleDeclaresNonEpub('A Manual (.PDF)'), true);
  assert.equal(titleDeclaresNonEpub('Comic Issue 1 (.cbr)'), true);
});

test('collectionResult: flags the set and carries the searched book for the UI', () => {
  const detail = {
    title: '7 Books by Sally Hepworth (.ePUB)',
    author: 'Sally Hepworth',
    description: 'Set blurb…',
    size: '3.7 MB',
    url: 'https://forum.mobilism.org/viewtopic.php?t=1',
    cover: 'https://example.com/set-first-cover.jpg',
    premium: true,
    postlinks: [],
  };
  const r = collectionResult(detail, { date: 'Oct 27th, 2020', category: 'eBooks' }, 'Mad Mabel', 'Sally Hepworth');
  assert.equal(r.collection, true);
  assert.equal(r.matchedTitle, 'Mad Mabel');     // the book the user actually wanted
  assert.equal(r.matchedAuthor, 'Sally Hepworth');
  assert.equal(r.setTitle, '7 Books by Sally Hepworth (.ePUB)'); // the set post title
  assert.equal(r.source, 'Found in collection');
  assert.equal(r.format, 'ePUB');
  // The set's first-book image must NOT ride along as this book's cover — that's
  // exactly what put the wrong artwork on a book and polluted the Library.
  assert.equal(r.cover, null);
});

test('collectionResult: trims the searched terms (empty when title-less)', () => {
  const detail = { title: 'A Set', author: '', description: '', url: 'u', cover: null, premium: false, postlinks: [] };
  const r = collectionResult(detail, {}, '  ', '  Ann Patchett ');
  assert.equal(r.matchedTitle, '');
  assert.equal(r.matchedAuthor, 'Ann Patchett');
});

test('titleDeclaresNonEpub: keeps epub and mixed-format and unmarked titles', () => {
  assert.equal(titleDeclaresNonEpub('It Ends with Us by Colleen Hoover (.ePUB)'), false);
  // epub alongside another format → still keep it.
  assert.equal(titleDeclaresNonEpub('Dune (.ePUB/.PDF)'), false);
  // No format marker at all → keep (lenient; fetchDetail resolves it).
  assert.equal(titleDeclaresNonEpub('The Hobbit by J.R.R. Tolkien'), false);
  // "mobi" inside an ordinary word must NOT count as a format marker.
  assert.equal(titleDeclaresNonEpub('Mobile Suit Gundam'), false);
});

test('titleLooksLikeAudiobook: catches AB tags and spelled-out audiobook markers', () => {
  assert.equal(titleLooksLikeAudiobook('Project Hail Mary by Andy Weir [AB]'), true);
  assert.equal(titleLooksLikeAudiobook('Project Hail Mary (AB)'), true);
  assert.equal(titleLooksLikeAudiobook('Project Hail Mary by Andy Weir - AB'), true);
  assert.equal(titleLooksLikeAudiobook('The Martian (Audiobook)'), true);
  assert.equal(titleLooksLikeAudiobook('The Martian [Unabridged]'), true);
  assert.equal(titleLooksLikeAudiobook('Some Title (Audible)'), true);
});

test('titleLooksLikeAudiobook: does NOT flag ordinary titles containing "ab"', () => {
  assert.equal(titleLooksLikeAudiobook('The AB Guide to Testing'), false); // "AB" mid-sentence, no tag
  assert.equal(titleLooksLikeAudiobook('Crab Cakes by Chef Ramsay'), false);
  assert.equal(titleLooksLikeAudiobook('About a Boy by Nick Hornby'), false);
  assert.equal(titleLooksLikeAudiobook('It Ends with Us (.ePUB)'), false);
});

test('titleDeclaresNonEpub: also skips audiobook-tagged titles with no extension', () => {
  assert.equal(titleDeclaresNonEpub('Project Hail Mary by Andy Weir [AB]'), true);
  assert.equal(titleDeclaresNonEpub('The Martian (Audiobook)'), true);
});

// --- resultForRow: a set post is a set, whichever pass found it --------------
// Regression: the author-fallback pass emitted set posts as PLAIN results, so a
// book dug out of "Kings Of Mafia Series by Michelle Heard" was filed under the
// set's title with the set's cover art instead of the book we searched for.
const { resultForRow } = require('../src/searcher');

const setDetail = {
  title: 'Kings Of Mafia Series',
  author: 'Michelle Heard',
  description: 'Book 1: Tempted by the Devil\nBook 2: Saved By A God',
  size: '2.4 MB',
  url: 'https://forum.mobilism.org/t5414877',
  cover: 'https://images.mobilism.org/set-first-book.jpg', // the SET's first book
  premium: true,
  postlinks: [],
};

test('resultForRow: a collection row is flagged as a set and carries the searched book', () => {
  const r = resultForRow(setDetail, { title: 'Kings Of Mafia Series by Michelle Heard (.ePUB)' }, {
    title: 'Saved By A God', author: 'Michelle Heard', source: 'Author fallback',
  });
  assert.equal(r.collection, true, 'must be flagged as a set');
  assert.equal(r.setTitle, 'Kings Of Mafia Series');
  assert.equal(r.matchedTitle, 'Saved By A God', 'carries the book we actually wanted');
  assert.equal(r.matchedAuthor, 'Michelle Heard');
  assert.equal(r.cover, null, "the set's first-book art must never ride along as this book's cover");
});

test('resultForRow: a plain book row stays a plain result, cover intact', () => {
  const detail = { ...setDetail, title: 'A Voice in the Dark', cover: 'https://images.mobilism.org/voice.jpg' };
  const r = resultForRow(detail, { title: 'A Voice in the Dark by Barbara Nickless (.ePUB)' }, {
    title: 'A Voice in the Dark', author: 'Barbara Nickless', source: 'Author fallback',
  });
  assert.ok(!r.collection, 'not a set');
  assert.equal(r.source, 'Author fallback');
  assert.equal(r.cover, 'https://images.mobilism.org/voice.jpg', "a real book post's image IS its cover");
});

test('CHROMIUM_ARGS caps the persistent profile disk cache', () => {
  const { CHROMIUM_ARGS } = require('../src/searcher');
  const cap = CHROMIUM_ARGS.find((a) => a.startsWith('--disk-cache-size='));
  assert.ok(cap, 'expected a --disk-cache-size flag');
  const bytes = Number(cap.split('=')[1]);
  assert.ok(bytes > 0 && bytes <= 512 * 1024 * 1024, `cache cap ${bytes} should be (0, 512 MB]`);
});

test('normalize: folds number words and honorifics', () => {
  assert.equal(normalize('Eleven Numbers'), '11 numbers');
  assert.equal(normalize('Mr. Mercedes'), 'mister mercedes');
  assert.equal(normalize('Dr Sleep'), 'doctor sleep');
  assert.equal(normalize('St. Elsewhere'), 'saint elsewhere');
  // whole words only
  assert.equal(normalize('Someone Like You'), 'someone like you');
  assert.equal(normalize('Mrs Dalloway'), 'mrs dalloway');
});

test('fuzzyMatch: number words ⇄ digits, abbreviations ⇄ full words', () => {
  assert.equal(fuzzyMatch('Eleven Numbers', '11 Numbers by Lee Child'), true);
  assert.equal(fuzzyMatch('Twelve Days', '12 Days by Jane Doe'), true);
  assert.equal(fuzzyMatch('Ready Player 1', 'Ready Player One by Ernest Cline'), true);
  assert.equal(fuzzyMatch('Mister Mercedes', 'Mr. Mercedes by Stephen King'), true);
  assert.equal(fuzzyMatch('Doctor Sleep', 'Dr Sleep by Stephen King'), true);
  // number tokens match whole: "One Day" must not hit "100 Days"
  assert.equal(fuzzyMatch('One Day', '100 Days by Jane Doe'), false);
  assert.equal(fuzzyMatch('1984', '1984: Illustrated'), true);
});

test('isCollection: "&" only signals a set in the title part, and not when the searched title has it', () => {
  // co-author "&" is not a set
  assert.equal(isCollection('The Thoroughbreds by Elin Hilderbrand & Shelby Cunningham (.ePUB)', 'The Thoroughbreds'), false);
  assert.equal(isCollection('The Thoroughbreds by Elin Hilderbrand & Shelby Cunningham (.ePUB)'), false);
  // the searched title owns the "&"
  assert.equal(isCollection('Pride & Prejudice by Jane Austen (.ePUB)', 'Pride and Prejudice'), false);
  assert.equal(isCollection('Pride & Prejudice by Jane Austen (.ePUB)', 'Pride & Prejudice'), false);
  // but a different title joined by "&" is a set
  assert.equal(isCollection('Pride & Prejudice by Jane Austen (.ePUB)', 'Emma'), true);
  assert.equal(isCollection('Pride & Prejudice by Jane Austen (.ePUB)'), true);
});

test('isCollection: "Complete", short fiction and the updated-set "(.ePUB)+" marker', () => {
  assert.equal(isCollection('Short Fiction Complete by Lee Child (ePUB)'), true);
  assert.equal(isCollection('The Complete Jack Reacher Short Fiction by Lee Child (ePUB)'), true);
  assert.equal(isCollection('Jack Reacher by Lee Child (.ePUB)+'), true);
  assert.equal(isCollection('Jack Reacher by Lee Child (.ePUB)'), false);
});

test('authorKeywords: drops the co-author connector for the forum query', () => {
  assert.equal(authorKeywords('Elin Hilderbrand and Shelby Cunningham'), 'Elin Hilderbrand Shelby Cunningham');
  assert.equal(authorKeywords('Elin Hilderbrand & Shelby Cunningham'), 'Elin Hilderbrand Shelby Cunningham');
  assert.equal(authorKeywords('Jennifer Hillier'), 'Jennifer Hillier');
  assert.equal(authorKeywords('Alexandra Andrews'), 'Alexandra Andrews'); // "and" inside a word stays
  assert.equal(authorKeywords(''), '');
});

test('titleKeywords: leaves variant-prone words out of the forum query', () => {
  assert.equal(titleKeywords('Mister Mercedes'), 'Mercedes');
  assert.equal(titleKeywords('Mr. Mercedes'), 'Mercedes');
  assert.equal(titleKeywords('Eleven Numbers'), 'Numbers');
  assert.equal(titleKeywords('Pride & Prejudice'), 'Pride Prejudice');
  assert.equal(titleKeywords('Doctor Sleep'), 'Sleep');
  // real content stays, incl. big numbers that are the title itself
  assert.equal(titleKeywords('1984'), '1984');
  assert.equal(titleKeywords('Catch-22'), 'Catch-22');
  assert.equal(titleKeywords('Heart of Glass'), 'Heart of Glass');
  // nothing left → raw title
  assert.equal(titleKeywords('Eleven'), 'Eleven');
  assert.equal(titleKeywords(''), '');
});

test('titleDeclaresNonEpub: review articles are not books', () => {
  assert.equal(titleDeclaresNonEpub('eBook Review: Mr. Mercedes by Stephen King - Good E-Reader'), true);
  assert.equal(titleDeclaresNonEpub('Review: Some Book'), true);
  assert.equal(titleDeclaresNonEpub('The Review by Jane Doe (.ePUB)'), false);
  assert.equal(titleDeclaresNonEpub('Book Review Club by Jane Doe (.ePUB)'), false);
});

test('bylineMismatch: someone else\'s set is rejected, the author\'s own (or unbylined) sets pass', () => {
  // other authors' sets that merely name the searched author
  assert.equal(bylineMismatch('Jane Austen Regency Life series by Maria Grace (.ePUB)', 'Jane Austen'), true);
  assert.equal(bylineMismatch("Jane Austen's Pride & Prejudice Sequel Bundle by Linda Berdoll (.ePUB)", 'Jane Austen'), true);
  assert.equal(bylineMismatch('3 Novels by Sharon Doering (.ePUB)', 'Jennifer Hillier'), true);
  // the searched author's own sets
  assert.equal(bylineMismatch('4 Novels by Jennifer Hillier (.ePUB)', 'Jennifer Hillier'), false);
  assert.equal(bylineMismatch('The Academy series by Elin Hilderbrand & Shelby Cunningham (.ePUB)', 'Elin Hilderbrand and Shelby Cunningham'), false);
  assert.equal(bylineMismatch('Jack Reacher series by Lee Child & Andrew Child (.ePUB)+', 'Lee Child'), false);
  assert.equal(bylineMismatch('In Death Series by J. D. Robb (.ePUB)', 'J.D. Robb'), false);
  // no byline, or no author searched → can't judge, keep
  assert.equal(bylineMismatch('Reacher Series (.ePUB)+', 'Lee Child'), false);
  assert.equal(bylineMismatch('Some Series by Anyone', ''), false);
  // "by" inside the set name, author last: the LAST byline decides
  assert.equal(bylineMismatch('Stand by Me Collection by Jane Doe', 'Jane Doe'), false);
});
