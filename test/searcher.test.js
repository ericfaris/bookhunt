'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { normalize, fuzzyMatch, fuzzyMatchLine, isCollection, titleDeclaresNonEpub, titleLooksLikeAudiobook, collectionResult } = require('../src/searcher');

test('normalize: lowercases, strips punctuation, collapses space', () => {
  assert.equal(normalize('1984: Illustrated!'), '1984 illustrated');
  assert.equal(normalize('  The   Hobbit  '), 'the hobbit');
  assert.equal(normalize(''), '');
  assert.equal(normalize(null), '');
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
  assert.equal(isCollection('Dune Omnibus'), true);
  assert.equal(isCollection('1984'), false);
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
