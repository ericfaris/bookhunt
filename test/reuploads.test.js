'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { parseRequestRows, normName } = require('../src/reuploads');

// --- parseRequestRows: raw UCP table rows → structured requests --------------

test('parseRequestRows: maps cells to {releaseName, requestedOn, releaserLastOnline}', () => {
  const rows = [
    ['Release Name', 'Requested on', 'Releaser last online'], // header — skipped
    ['1984 & Animal Farm by George Orwell (.M4B)', '2 minutes ago', 'Today, 12:01 am'],
    ['5 Books by Julianne MacLean (.ePUB)', '11 minutes ago', 'Today, 12:01 am'],
  ];
  const out = parseRequestRows(rows);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    releaseName: '1984 & Animal Farm by George Orwell (.M4B)',
    requestedOn: '2 minutes ago',
    releaserLastOnline: 'Today, 12:01 am',
  });
  assert.equal(out[1].releaseName, '5 Books by Julianne MacLean (.ePUB)');
});

test('parseRequestRows: collapses whitespace and skips empty rows', () => {
  const rows = [
    ['  A Lineage of Grace   by Francine Rivers (.ePUB) ', 'Jun 13th, 2026, 11:20am', 'Today'],
    [''], // no release name → skipped
    [],   // empty → skipped
  ];
  const out = parseRequestRows(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].releaseName, 'A Lineage of Grace by Francine Rivers (.ePUB)');
});

test('parseRequestRows: tolerates missing trailing cells', () => {
  const out = parseRequestRows([['Only a name']]);
  assert.deepEqual(out, [{ releaseName: 'Only a name', requestedOn: '', releaserLastOnline: '' }]);
});

test('parseRequestRows: tolerates empty / undefined input', () => {
  assert.deepEqual(parseRequestRows(), []);
  assert.deepEqual(parseRequestRows([]), []);
});

test('normName: lowercases + collapses whitespace for matching', () => {
  assert.equal(normName('  Dune   by  Frank '), 'dune by frank');
  assert.equal(normName(null), '');
});
