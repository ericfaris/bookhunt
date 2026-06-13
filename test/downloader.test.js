'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const downloader = require('../src/downloader');
const { verifyEpub, sanitizeUrl, cleanError, isSafeEpubPath } = downloader;

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
