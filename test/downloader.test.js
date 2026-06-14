'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeEpub: writeRealEpub } = require('./helpers');

const downloader = require('../src/downloader');
const {
  verifyEpub,
  verifyBook,
  sanitizeUrl,
  cleanError,
  isSafeEpubPath,
  looksLikeHtmlBuffer,
  isHtmlFile,
  fsSafe,
  extractYear,
  cleanBookTitle,
  buildBookFilename,
  sectionMatchesTitle,
  selectPremiumLinks,
} = downloader;

// Build a buffer that looks like a real EPUB: ZIP magic at 0, and the
// uncompressed `mimetype` entry the spec requires, padded past the 1 KB floor.
function epubBuffer() {
  const head = Buffer.alloc(58, 0);
  head.write('PK\x03\x04', 0, 'latin1');
  head.write('mimetype', 30, 'latin1');
  head.write('application/epub+zip', 38, 'latin1');
  return Buffer.concat([head, Buffer.alloc(2000, 0x20)]);
}

function tmp(name, buf) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'epubtest-')), name);
  fs.writeFileSync(p, buf);
  return p;
}

test('verifyEpub: accepts a real epub', () => {
  const v = verifyEpub(tmp('book.epub', epubBuffer()));
  assert.equal(v.ok, true);
  assert.equal(v.epub, true);
  assert.ok(v.size > 1024);
});

test('verifyEpub: a plain zip is ok (valid) but not flagged epub', () => {
  const zip = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(2000, 0)]);
  const v = verifyEpub(tmp('archive.zip', zip));
  assert.equal(v.ok, true); // ZIP magic + size
  assert.equal(v.epub, false); // no mimetype header
});

test('verifyEpub: rejects a too-small file', () => {
  const v = verifyEpub(tmp('tiny.epub', Buffer.from('PK\x03\x04tiny', 'latin1')));
  assert.equal(v.ok, false);
});

test('verifyEpub: rejects a non-zip (e.g. an HTML error page)', () => {
  const html = Buffer.from('<html><body>Not Found</body></html>'.repeat(50));
  const v = verifyEpub(tmp('error.epub', html));
  assert.equal(v.ok, false);
});

test('verifyEpub: rejects a missing file', () => {
  const v = verifyEpub('/no/such/file.epub');
  assert.deepEqual(v, { ok: false, size: 0, epub: false });
});

test('sanitizeUrl: strips trailing quotes / encoded quotes', () => {
  assert.equal(sanitizeUrl('https://h/x.epub&quot;'), 'https://h/x.epub');
  assert.equal(sanitizeUrl('https://h/x.epub">'), 'https://h/x.epub');
  assert.equal(sanitizeUrl('  https://h/x.epub  '), 'https://h/x.epub');
  assert.equal(sanitizeUrl(null), '');
});

test('cleanError: trims and drops a leading title> artifact', () => {
  assert.equal(cleanError('title&gt;Not Found'.replace('&gt;', '>')), 'Not Found');
  assert.equal(cleanError('  Account   expired  '), 'Account expired');
  assert.equal(cleanError(''), 'download failed');
});

test('isSafeEpubPath: accepts an epub inside the root', () => {
  assert.equal(isSafeEpubPath('/downloads/book.epub', '/downloads'), true);
  assert.equal(isSafeEpubPath('/downloads/sub/book.EPUB', '/downloads'), true);
});

test('isSafeEpubPath: rejects traversal, outside-root, and non-epub', () => {
  assert.equal(isSafeEpubPath('/downloads/../etc/passwd.epub', '/downloads'), false);
  assert.equal(isSafeEpubPath('/etc/passwd.epub', '/downloads'), false);
  assert.equal(isSafeEpubPath('/downloads/book.rar', '/downloads'), false);
  assert.equal(isSafeEpubPath('', '/downloads'), false);
  assert.equal(isSafeEpubPath('/downloads/book.epub', ''), false);
});

// --- Regression guards: HTML pages must never count as a downloaded file -----
// (Case 3: a host served its own landing page; we saved 38 KB of HTML and
// reported it as a successful download.)
test('looksLikeHtmlBuffer: detects HTML landing/error pages', () => {
  assert.equal(looksLikeHtmlBuffer(Buffer.from('<!DOCTYPE html><html>...')), true);
  assert.equal(looksLikeHtmlBuffer(Buffer.from('  \n<html lang="en">')), true);
  assert.equal(looksLikeHtmlBuffer(Buffer.from('<HEAD><title>404</title>')), true);
});

test('looksLikeHtmlBuffer: does NOT flag real book/archive bytes', () => {
  assert.equal(looksLikeHtmlBuffer(Buffer.from('PK\x03\x04', 'latin1')), false); // epub/zip
  assert.equal(looksLikeHtmlBuffer(Buffer.from('%PDF-1.7\n', 'latin1')), false); // pdf
  assert.equal(looksLikeHtmlBuffer(Buffer.alloc(0)), false);
});

test('isHtmlFile: flags .html/.htm by name and HTML by content', () => {
  // by extension (the case-3 filename was "...pdf.html")
  const named = tmp('Ranger.Rick.2026.pdf.html', Buffer.from('PK\x03\x04anything'));
  assert.equal(isHtmlFile(named, 'Ranger.Rick.2026.pdf.html'), true);
  // by content even with a book-looking extension
  const htmlAsEpub = tmp('fake.epub', Buffer.from('<!doctype html><html></html>'));
  assert.equal(isHtmlFile(htmlAsEpub, 'fake.epub'), true);
});

test('isHtmlFile: passes a real epub through', () => {
  const real = tmp('real.epub', epubBuffer());
  assert.equal(isHtmlFile(real, 'real.epub'), false);
});

// --- Filename building: "Title [Author] (Year).ext" --------------------------
test('fsSafe: strips filesystem-illegal characters and tidies whitespace', () => {
  assert.equal(fsSafe('a/b\\c:d*e?f"g<h>i|j'), 'abcdefghij');
  assert.equal(fsSafe('  spaced   out  '), 'spaced out');
  assert.equal(fsSafe('trailing dots...'), 'trailing dots'); // no trailing dot (Windows)
  assert.equal(fsSafe('keep-hyphens & co'), 'keep-hyphens & co');
  assert.equal(fsSafe(null), '');
});

test('extractYear: finds a 19xx/20xx year, else null', () => {
  assert.equal(extractYear('Some Book (2024) Retail'), '2024');
  assert.equal(extractYear('Published 1999 edition'), '1999');
  assert.equal(extractYear('no year here'), null);
  assert.equal(extractYear('version 3000 not a year'), null);
});

test('cleanBookTitle: drops "by Author" tail and trailing format/year parentheticals', () => {
  assert.equal(cleanBookTitle('The Great Book by Jane Doe (2024, Penguin)'), 'The Great Book');
  assert.equal(cleanBookTitle('Some Title - ePUB'), 'Some Title');
  assert.equal(cleanBookTitle('Another Title (Retail EPUB)'), 'Another Title');
  assert.equal(cleanBookTitle('Plain Title'), 'Plain Title');
  // a colon subtitle is kept (unlike Amazon's cleanTitle)
  assert.equal(cleanBookTitle('Main: A Subtitle'), 'Main: A Subtitle');
});

test('buildBookFilename: composes Title [Author] (Year) and keeps the served extension', () => {
  assert.equal(
    buildBookFilename({ title: 'The Great Book by Jane Doe (2024)', author: 'Jane Doe' }, 'rawfile.epub'),
    'The Great Book [Jane Doe] (2024).epub'
  );
  // non-epub extension is preserved
  assert.equal(
    buildBookFilename({ title: 'Manual (2021)', author: 'Acme' }, 'host-name-123.pdf'),
    'Manual [Acme] (2021).pdf'
  );
});

test('buildBookFilename: omits author/year when absent', () => {
  assert.equal(buildBookFilename({ title: 'Just A Title' }, 'x.epub'), 'Just A Title.epub');
  assert.equal(
    buildBookFilename({ title: 'Titled', author: 'Bob' }, 'x.mobi'),
    'Titled [Bob].mobi'
  );
});

test('buildBookFilename: falls back to the sanitized original name when title is empty', () => {
  assert.equal(buildBookFilename({ title: '' }, 'fallback-name.epub'), 'fallback-name.epub');
  assert.equal(buildBookFilename(null, ''), 'download.epub'); // nothing at all
});

// --- verifyBook: confirm it's the CORRECT book, not just a valid ZIP ---------
test('verifyBook: embedded title matching the search → titleMatch true', () => {
  const p = writeRealEpub('book.epub', 'The Great Book', 'Jane Doe');
  const v = verifyBook(p, 'Great Book');
  assert.equal(v.ok, true);
  assert.equal(v.epub, true);
  assert.equal(v.embeddedTitle, 'The Great Book');
  assert.equal(v.embeddedAuthor, 'Jane Doe');
  assert.equal(v.titleMatch, true);
});

test('verifyBook: embedded title NOT matching the search → titleMatch false', () => {
  const p = writeRealEpub('book.epub', 'Some Other Novel', 'Bob');
  const v = verifyBook(p, 'The Great Book');
  assert.equal(v.ok, true);
  assert.equal(v.embeddedTitle, 'Some Other Novel');
  assert.equal(v.titleMatch, false);
});

test('verifyBook: no expected title → titleMatch null but embedded title still read', () => {
  const p = writeRealEpub('book.epub', 'Standalone Title', 'A');
  const v = verifyBook(p, '');
  assert.equal(v.embeddedTitle, 'Standalone Title');
  assert.equal(v.titleMatch, null);
});

test('verifyBook: a plain (non-ePUB) zip → no embedded title, titleMatch null', () => {
  const zip = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(2000, 0)]);
  const v = verifyBook(tmp('archive.zip', zip), 'Anything');
  assert.equal(v.ok, true); // structurally a valid zip
  assert.equal(v.epub, false);
  assert.equal(v.embeddedTitle, '');
  assert.equal(v.titleMatch, null);
});

// ---------------------------------------------------------------------------
// Per-book section selection in "Books by Author" collection posts.
// Scenario mirrors the real "Whistler — Ann Patchett" post: a first
// "Download Instructions" link that is an archive of all 7 books, then a
// per-book section "W:" (Whistler) with its own mirror links.
// ---------------------------------------------------------------------------
test('sectionMatchesTitle: single-letter abbreviation ("W:" → Whistler)', () => {
  assert.equal(sectionMatchesTitle('W:', 'Whistler'), true);
  assert.equal(sectionMatchesTitle('W', 'Whistler'), true);
});

test('sectionMatchesTitle: multi-letter abbreviation ("TL:" → The Lacuna)', () => {
  assert.equal(sectionMatchesTitle('TL:', 'The Lacuna'), true);
  assert.equal(sectionMatchesTitle('TCC', 'The Calamity Club'), true);
});

test('sectionMatchesTitle: full book name in the header matches', () => {
  assert.equal(sectionMatchesTitle('Whistler (.ePUB)', 'Whistler'), true);
});

test('sectionMatchesTitle: the all-books archive header does NOT match a book', () => {
  assert.equal(sectionMatchesTitle('Download Instructions:', 'Whistler'), false);
  assert.equal(sectionMatchesTitle('Complete Collection', 'Whistler'), false);
});

test('selectPremiumLinks: picks the per-book section over the all-books archive', () => {
  const detailTitle = 'Books by Ann Patchett (.ePUB)';
  const postlinks = [
    { url: 'https://filedot.to/archive7', premium: true, sectionHeader: 'Download Instructions:' },
    { url: 'https://send.now/d/ajTF', premium: true, sectionHeader: 'TL:' },
    { url: 'https://send.now/6lb2', premium: true, sectionHeader: 'W:' },
    { url: 'https://filedot.to/ku6w', premium: true, sectionHeader: 'W:' },
  ];
  const chosen = selectPremiumLinks(postlinks, detailTitle, 'Whistler');
  assert.deepEqual(
    chosen.map((l) => l.url),
    ['https://send.now/6lb2', 'https://filedot.to/ku6w'],
    'only the two Whistler ("W:") mirror links, not the 7-book archive'
  );
});

test('selectPremiumLinks: single-book post (title matches) uses all links, no filtering', () => {
  const postlinks = [
    { url: 'https://a/1', premium: true, sectionHeader: 'Download:' },
    { url: 'https://a/2', premium: true, sectionHeader: '' },
  ];
  const chosen = selectPremiumLinks(postlinks, 'Whistler by Ann Patchett (.ePUB)', 'Whistler');
  assert.equal(chosen.length, 2);
});

test('selectPremiumLinks: no section matches → falls back to all links (still tries)', () => {
  const postlinks = [
    { url: 'https://a/1', premium: true, sectionHeader: 'Download Instructions:' },
    { url: 'https://a/2', premium: true, sectionHeader: 'Bel Canto:' },
  ];
  // Target not present as any section → don't drop everything; return all so the
  // archive (which extraction can still unwrap) is at least attempted.
  const chosen = selectPremiumLinks(postlinks, 'Books by Ann Patchett', 'Whistler');
  assert.equal(chosen.length, 2);
});
