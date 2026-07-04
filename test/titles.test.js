'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { displayTitle, titleFromFilename, isJunkTitle, gentleTitleCase } = require('../src/titles');

// Real artifacts observed in the production Library.

test('displayTitle: strips forum format tails', () => {
  assert.equal(
    displayTitle({ title: 'Theo of Golden by Allen Levi (.ePUB)', author: 'Allen Levi' }),
    'Theo of Golden'
  );
  assert.equal(
    displayTitle({ title: 'A Lineage of Grace by Francine Rivers (.ePUB)', author: 'Francine Rivers' }),
    'A Lineage of Grace'
  );
});

test('displayTitle: strips leading batch dashes', () => {
  assert.equal(displayTitle({ title: '- Shred Sisters', author: 'Betsy Lerner' }), 'Shred Sisters');
  assert.equal(displayTitle({ title: '- Bitter Sweet' }), 'Bitter Sweet');
});

test('displayTitle: multi-book collection posts fall back to the filename title', () => {
  assert.equal(
    displayTitle({
      title: '2 Books by Kathryn Stockett (.ePUB)',
      author: 'Kathryn Stockett',
      filename: 'The Calamity Club [Kathryn Stockett].epub',
    }),
    'The Calamity Club'
  );
});

test('displayTitle: strips "by <author>" only when it names this book’s author', () => {
  // Multi-author byline, author field holds just the first name.
  assert.equal(
    displayTitle({ title: 'Sekret Machines: Gods by Tom DeLonge, Peter Levenda (.ePUB)', author: 'Tom DeLonge' }),
    'Sekret Machines: Gods'
  );
  // A title that happens to contain "by" mid-sentence is untouched.
  assert.equal(displayTitle({ title: 'Death by Chocolate', author: 'Someone Else' }), 'Death by Chocolate');
});

test('displayTitle: gently re-cases all-lowercase batch input, leaves cased titles alone', () => {
  assert.equal(displayTitle({ title: 'Broken country' }), 'Broken Country');
  assert.equal(displayTitle({ title: 'The three lives of cate kay' }), 'The Three Lives of Cate Kay');
  assert.equal(displayTitle({ title: 'The Someday Garden' }), 'The Someday Garden');
  assert.equal(displayTitle({ title: "Show don't tell" }), "Show Don't Tell");
});

test('displayTitle: clean titles pass through unchanged', () => {
  for (const t of ['Whistler', 'Yesteryear', 'Wild Dark Shore', 'Here One Moment']) {
    assert.equal(displayTitle({ title: t }), t);
  }
});

test('displayTitle: never returns empty — falls back to the raw title', () => {
  assert.equal(displayTitle({ title: '(.ePUB)' , filename: null }), '(.ePUB)');
});

test('titleFromFilename: parses the app’s own filename convention', () => {
  assert.equal(titleFromFilename('Project Hail Mary [Andy Weir].epub'), 'Project Hail Mary');
  assert.equal(titleFromFilename('Theo of Golden [Allen Levi] (2024).epub'), 'Theo of Golden');
  assert.equal(titleFromFilename('random_download.epub'), null);
});

test('isJunkTitle: collection posts and blanks', () => {
  assert.equal(isJunkTitle('2 Books by Kathryn Stockett'), true);
  assert.equal(isJunkTitle('3 novels by Someone'), true);
  assert.equal(isJunkTitle(''), true);
  assert.equal(isJunkTitle('Two Cities'), false);
});

test('gentleTitleCase: no-op on anything already cased', () => {
  assert.equal(gentleTitleCase('McConaghy Writes'), 'McConaghy Writes');
  assert.equal(gentleTitleCase('NW'), 'NW');
});
