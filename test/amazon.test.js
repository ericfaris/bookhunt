'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { isAmazonUrl, cleanTitle, cleanAuthor } = require('../src/amazon');

test('isAmazonUrl: accepts amazon hosts, a.co, amzn', () => {
  assert.equal(isAmazonUrl('https://www.amazon.com/dp/0451524934'), true);
  assert.equal(isAmazonUrl('https://amazon.co.uk/dp/X'), true);
  assert.equal(isAmazonUrl('https://a.co/d/abc'), true);
  assert.equal(isAmazonUrl('https://amzn.to/3xyz'), true);
});

test('isAmazonUrl: rejects non-amazon and garbage', () => {
  assert.equal(isAmazonUrl('https://example.com/dp/X'), false);
  assert.equal(isAmazonUrl('https://notamazon.com'), false); // not the amazon.* host
  assert.equal(isAmazonUrl('not a url'), false);
  assert.equal(isAmazonUrl(''), false);
});

test('cleanTitle: drops subtitle after a colon', () => {
  assert.equal(cleanTitle('1984: 75th Anniversary'), '1984');
  assert.equal(cleanTitle('Dune: Book One'), 'Dune');
});

test('cleanTitle: strips trailing edition/format parentheticals', () => {
  assert.equal(cleanTitle('The Hobbit (Kindle Edition)'), 'The Hobbit');
  assert.equal(cleanTitle('Dune (Paperback)'), 'Dune');
  assert.equal(cleanTitle('Plain Title'), 'Plain Title');
  assert.equal(cleanTitle(''), '');
});

test('cleanAuthor: strips role labels and trailing punctuation', () => {
  assert.equal(cleanAuthor('George Orwell (Author)'), 'George Orwell');
  assert.equal(cleanAuthor('Jane Smith,'), 'Jane Smith');
  assert.equal(cleanAuthor('  Ann Napolitano  '), 'Ann Napolitano');
  assert.equal(cleanAuthor(''), '');
});
