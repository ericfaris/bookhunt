'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// resolveArchive writes the extracted ePUB to DOWNLOAD_PATH (captured at module
// load), so point it at a temp dir BEFORE requiring the downloader.
const DL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-dl-'));
process.env.DOWNLOAD_PATH = DL_DIR;

const { storedZip, epubBuffer, writeTmp } = require('./helpers');
const {
  sniffArchive,
  extractEpubs,
  looksLikeEpub,
  extractEpubsFromZipBuffer,
} = require('../src/archive');
const { pickEpub, resolveArchive, finalizeDownload } = require('../src/downloader');
const { parseEpubBuffer } = require('../src/epub');

const RAR_FIXTURE = path.join(__dirname, 'fixtures', 'book.rar');

// A ZIP that *wraps* an ePUB (the real-world case: a release archived as .zip).
function zipWrappingEpub(entries) {
  return storedZip(entries);
}

test('sniffArchive: distinguishes bare ePUB, ZIP-of-ePUB, RAR, and other', () => {
  const epub = writeTmp('book.epub', epubBuffer('T', 'A'));
  const zip = writeTmp('book.zip', zipWrappingEpub([{ name: 'T.epub', data: epubBuffer('T', 'A') }]));
  const other = writeTmp('book.txt', Buffer.from('just text, not an archive'));

  assert.equal(sniffArchive(epub), 'epub');
  assert.equal(sniffArchive(zip), 'zip');
  assert.equal(sniffArchive(RAR_FIXTURE), 'rar');
  assert.equal(sniffArchive(other), 'other');
});

test('looksLikeEpub: true for an ePUB, false for a ZIP that merely contains one', () => {
  assert.equal(looksLikeEpub(epubBuffer('T', 'A').slice(0, 64)), true);
  const zip = zipWrappingEpub([{ name: 'T.epub', data: epubBuffer('T', 'A') }]);
  assert.equal(looksLikeEpub(zip.slice(0, 64)), false);
});

test('extractEpubsFromZipBuffer: pulls every .epub entry out of a ZIP', () => {
  const zip = zipWrappingEpub([
    { name: 'readme.txt', data: 'ignore me' },
    { name: 'Book One.epub', data: epubBuffer('Book One', 'A') },
    { name: 'nested/Book Two.EPUB', data: epubBuffer('Book Two', 'B') },
  ]);
  const epubs = extractEpubsFromZipBuffer(zip);
  const names = epubs.map((e) => e.name).sort();
  assert.deepEqual(names, ['Book One.epub', 'nested/Book Two.EPUB']);
  assert.equal(parseEpubBuffer(epubs.find((e) => /One/.test(e.name)).data).title, 'Book One');
});

test('extractEpubs: returns [] for a bare ePUB (nothing to unwrap)', async () => {
  const epub = writeTmp('plain.epub', epubBuffer('T', 'A'));
  assert.deepEqual(await extractEpubs(epub), []);
});

test('extractEpubs: reads the inner ePUB out of a real RAR archive', async () => {
  const epubs = await extractEpubs(RAR_FIXTURE);
  assert.equal(epubs.length, 1);
  assert.equal(parseEpubBuffer(epubs[0].data).title, 'The Great Book');
});

test('pickEpub: prefers the entry whose embedded title matches', () => {
  const a = { name: 'a.epub', data: epubBuffer('Bel Canto', 'Ann Patchett') };
  const b = { name: 'b.epub', data: epubBuffer('Some Other Book', 'X') };
  assert.equal(pickEpub([b, a], 'Bel Canto').name, 'a.epub');
});

test('pickEpub: falls back to the largest entry when nothing matches', () => {
  const small = { name: 's.epub', data: Buffer.alloc(100) };
  const big = { name: 'b.epub', data: Buffer.alloc(5000) };
  assert.equal(pickEpub([small, big], 'No Such Title').name, 'b.epub');
});

test('resolveArchive: unwraps a ZIP to a real .epub on disk and deletes the archive', async () => {
  const archivePath = path.join(DL_DIR, 'Wrapped.zip');
  fs.writeFileSync(archivePath, zipWrappingEpub([{ name: 'inner.epub', data: epubBuffer('Bel Canto', 'Ann Patchett') }]));

  const events = [];
  const out = await resolveArchive(archivePath, 'Wrapped.zip', { title: 'Bel Canto', author: 'Ann Patchett' }, (e) => events.push(e.step));

  assert.ok(out.savePath.toLowerCase().endsWith('.epub'), 'result is an .epub path');
  assert.ok(fs.existsSync(out.savePath), 'extracted .epub exists');
  assert.ok(!fs.existsSync(archivePath), 'archive was removed');
  assert.equal(parseEpubBuffer(fs.readFileSync(out.savePath)).title, 'Bel Canto');
  assert.deepEqual(events, ['extracting', 'extracted']);
});

test('resolveArchive: passes a bare ePUB through untouched', async () => {
  const p = writeTmp('plain.epub', epubBuffer('T', 'A'));
  const out = await resolveArchive(p, 'plain.epub', { title: 'T' });
  assert.equal(out.savePath, p);
  assert.equal(out.filename, 'plain.epub');
});

test('resolveArchive: throws (and cleans up) when an archive has no ePUB inside', async () => {
  const archivePath = path.join(DL_DIR, 'NoEpub.zip');
  fs.writeFileSync(archivePath, storedZip([{ name: 'cover.jpg', data: Buffer.alloc(2000) }]));
  await assert.rejects(
    () => resolveArchive(archivePath, 'NoEpub.zip', { title: 'X' }),
    /No EPUB found inside the ZIP/
  );
  assert.ok(!fs.existsSync(archivePath), 'failed archive was removed');
});

test('finalizeDownload: end-to-end unwraps a ZIP then verifies the inner ePUB', async () => {
  const archivePath = path.join(DL_DIR, 'E2E.zip');
  fs.writeFileSync(archivePath, zipWrappingEpub([{ name: 'inner.epub', data: epubBuffer('Bel Canto', 'Ann Patchett') }]));

  const rec = await finalizeDownload(archivePath, 'E2E.zip', { title: 'Bel Canto', author: 'Ann Patchett' });
  assert.equal(rec.verified, true);
  assert.equal(rec.titleMatch, true);
  assert.equal(rec.embeddedTitle, 'Bel Canto');
  assert.ok(rec.savePath.toLowerCase().endsWith('.epub'));
});
