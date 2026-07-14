'use strict';

// library.ownsBook is the shared "already on the shelf?" guard used by BOTH the
// new-release radar (never re-acquire an owned book) and the manual watch API
// (don't let the user watch a book they already have). It builds the live
// Library from the on-disk history, so we point HISTORY_FILE at a temp file
// BEFORE requiring anything that reads it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-owns-'));
process.env.HISTORY_FILE = path.join(TMP, 'history.json');

const { test } = require('node:test');
const assert = require('node:assert');

const history = require('../src/history');
const library = require('../src/library');

function seedOneBook() {
  fs.writeFileSync(process.env.HISTORY_FILE, '[]');
  history.add({
    type: 'download', title: 'Project Hail Mary', author: 'Andy Weir',
    savePath: '/downloads/phm.epub', filename: 'phm.epub', mode: 'premium', verified: true,
  });
}

test('ownsBook: true when a matching book is on the shelf', () => {
  seedOneBook();
  assert.equal(library.ownsBook({ title: 'Project Hail Mary', author: 'Andy Weir' }), true);
});

test('ownsBook: false for a book not in the Library', () => {
  seedOneBook();
  assert.equal(library.ownsBook({ title: 'A Totally Different Novel', author: 'Nobody At All' }), false);
});

test('ownsBook: match is case-insensitive', () => {
  seedOneBook();
  assert.equal(library.ownsBook({ title: 'project hail mary', author: 'andy weir' }), true);
});

test('ownsBook: same title but a different author is NOT owned', () => {
  seedOneBook();
  // Author corroboration keeps a same-title, different-author book from
  // falsely reading as owned.
  assert.equal(library.ownsBook({ title: 'Project Hail Mary', author: 'Someone Else' }), false);
});

test('ownsBook: empty query is never "owned"', () => {
  seedOneBook();
  assert.equal(library.ownsBook({ title: '', author: '' }), false);
});
