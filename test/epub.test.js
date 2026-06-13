'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readEpubMetadata, findEOCD, tagText } = require('../src/epub');
const { storedZip, writeEpub } = require('./helpers');

test('readEpubMetadata: reads title and author from a well-formed ePUB', () => {
  const p = writeEpub('book.epub', 'The Great Book', 'Jane Doe');
  const meta = readEpubMetadata(p);
  assert.equal(meta.ok, true);
  assert.equal(meta.title, 'The Great Book');
  assert.equal(meta.author, 'Jane Doe');
  assert.equal(meta.opfPath, 'OEBPS/content.opf');
});

test('readEpubMetadata: decodes XML entities in the title', () => {
  const p = writeEpub('amp.epub', 'Tom &amp; Jerry: A &quot;Tale&quot;', 'A &amp; B');
  const meta = readEpubMetadata(p);
  assert.equal(meta.title, 'Tom & Jerry: A "Tale"');
  assert.equal(meta.author, 'A & B');
});

test('readEpubMetadata: ok:false on a non-zip file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epub-'));
  const p = path.join(dir, 'nope.epub');
  fs.writeFileSync(p, Buffer.from('<!doctype html><html></html>'));
  assert.equal(readEpubMetadata(p).ok, false);
});

test('readEpubMetadata: ok:false when container.xml is missing', () => {
  const buf = storedZip([{ name: 'random.txt', data: 'hello' }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epub-'));
  const p = path.join(dir, 'nocontainer.epub');
  fs.writeFileSync(p, buf);
  assert.equal(readEpubMetadata(p).ok, false);
});

test('readEpubMetadata: ok:false on a missing file', () => {
  assert.equal(readEpubMetadata('/no/such/file.epub').ok, false);
});

test('findEOCD: returns null when there is no EOCD signature', () => {
  assert.equal(findEOCD(Buffer.from('not a zip at all')), null);
});

test('tagText: namespace-agnostic and entity-decoding', () => {
  assert.equal(tagText('<dc:title>Hi &amp; Bye</dc:title>', 'title'), 'Hi & Bye');
  assert.equal(tagText('<title>Plain</title>', 'title'), 'Plain');
  assert.equal(tagText('<other>x</other>', 'title'), '');
});
