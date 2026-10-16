'use strict';

// Cover IMAGE store (src/coverstore.js) + the ePUB cover extractor it uses.
// Never touches the network: fetches, catalog lookups and book reads are all
// injected; images go to a temp dir.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const { storedZip } = require('./helpers');
const { extractCoverImage, sniffImageMime, resolveZipPath } = require('../src/epub');
const coverstore = require('../src/coverstore');

// Minimal "real" images: valid magic bytes, padded past MIN_IMAGE_BYTES.
const pad = (head) => Buffer.concat([head, Buffer.alloc(2000, 7)]);
const JPEG = pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]));
const PNG = pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-coverstore-'));

const CONTAINER = '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>';
function epubWith(opfBody, extra = []) {
  return storedZip([
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: `<package><metadata><dc:title>T</dc:title></metadata>${opfBody}</package>` },
    ...extra,
  ]);
}

// --- ePUB cover extraction ------------------------------------------------------

test('sniffImageMime: jpeg/png by magic bytes; html and junk rejected', () => {
  assert.equal(sniffImageMime(JPEG), 'image/jpeg');
  assert.equal(sniffImageMime(PNG), 'image/png');
  assert.equal(sniffImageMime(Buffer.from('<html>nope</html>')), null);
  assert.equal(sniffImageMime(null), null);
});

test('resolveZipPath: relative to the OPF/page directory, ../ and %20 handled', () => {
  assert.equal(resolveZipPath('OEBPS/content.opf', 'images/c.jpg'), 'OEBPS/images/c.jpg');
  assert.equal(resolveZipPath('OEBPS/text/cover.xhtml', '../images/my%20cover.jpg#x'), 'OEBPS/images/my cover.jpg');
});

test('extractCoverImage: EPUB 3 properties="cover-image"', () => {
  const buf = epubWith('<manifest><item id="c" href="img/cover.jpg" media-type="image/jpeg" properties="cover-image"/></manifest>',
    [{ name: 'OEBPS/img/cover.jpg', data: JPEG }]);
  const out = extractCoverImage(buf);
  assert.equal(out.mime, 'image/jpeg');
  assert.ok(out.bytes.equals(JPEG));
});

test('extractCoverImage: EPUB 2 <meta name="cover"> → manifest id', () => {
  const buf = epubWith('<metadata><meta name="cover" content="cov"/></metadata><manifest><item id="cov" href="Images/front.png" media-type="image/png"/></manifest>',
    [{ name: 'OEBPS/Images/front.png', data: PNG }]);
  assert.equal(extractCoverImage(buf).mime, 'image/png');
});

test('extractCoverImage: guide cover page → its <img>', () => {
  const buf = epubWith(
    '<manifest><item id="p" href="Text/cover.xhtml" media-type="application/xhtml+xml"/></manifest><guide><reference type="cover" href="Text/cover.xhtml"/></guide>',
    [
      { name: 'OEBPS/Text/cover.xhtml', data: '<html><body><img src="../Images/c.jpg"/></body></html>' },
      { name: 'OEBPS/Images/c.jpg', data: JPEG },
    ]);
  assert.equal(extractCoverImage(buf).mime, 'image/jpeg');
});

test('extractCoverImage: image item named "cover" as a last resort', () => {
  const buf = epubWith('<manifest><item id="x1" href="cover-art.jpg" media-type="image/jpeg"/></manifest>',
    [{ name: 'OEBPS/cover-art.jpg', data: JPEG }]);
  assert.equal(extractCoverImage(buf).mime, 'image/jpeg');
});

test('extractCoverImage: no cover / non-image bytes / garbage → null, never throws', () => {
  assert.equal(extractCoverImage(epubWith('<manifest></manifest>')), null);
  const fake = epubWith('<manifest><item id="c" href="c.jpg" media-type="image/jpeg" properties="cover-image"/></manifest>',
    [{ name: 'OEBPS/c.jpg', data: '<html>404</html>' }]);
  assert.equal(extractCoverImage(fake), null);
  assert.equal(extractCoverImage(Buffer.from('not a zip')), null);
  assert.equal(extractCoverImage(undefined), null);
});

// --- Generated cover ---------------------------------------------------------------

test('generatedCoverSvg: title + author typeset, XML-escaped, stable color per title', () => {
  const a = coverstore.generatedCoverSvg({ title: 'Tom & <Jerry>', author: 'A. Author' });
  assert.match(a, /^<svg /);
  assert.ok(a.includes('Tom &amp;') && a.includes('&lt;Jerry&gt;'), 'escaped');
  assert.ok(a.includes('A. AUTHOR'));
  assert.ok(!a.includes('<Jerry>'));
  assert.equal(a, coverstore.generatedCoverSvg({ title: 'Tom & <Jerry>', author: 'A. Author' }));
});

test('wrapWords: wraps, hard-splits long words, caps lines with an ellipsis', () => {
  assert.deepEqual(coverstore.wrapWords('the quick brown fox', 10, 6), ['the quick', 'brown fox']);
  assert.deepEqual(coverstore.wrapWords('abcdefghijklmnop', 6, 6), ['abcdef', 'ghijkl', 'mnop']);
  const capped = coverstore.wrapWords('one two three four five six seven', 4, 2);
  assert.equal(capped.length, 2);
  assert.ok(capped[1].endsWith('…'));
});

// --- getCoverImage chain -------------------------------------------------------

const BOOK = { title: 'The Safe Room', author: 'Lisa Unger' };

test('getCoverImage: stored cover URL wins; large rendition tried first; saved to disk', async () => {
  const dir = tmpDir();
  const asked = [];
  const out = await coverstore.getCoverImage({ ...BOOK, cover: 'https://covers.openlibrary.org/b/id/1-M.jpg' }, {
    dir,
    fetchImage: async (u) => { asked.push(u); return JPEG; },
    resolveCover: async () => { throw new Error('should not be asked'); },
  });
  assert.equal(out.source, 'stored-url');
  assert.equal(out.mime, 'image/jpeg');
  assert.deepEqual(asked, ['https://covers.openlibrary.org/b/id/1-L.jpg']);
  assert.ok(fs.existsSync(path.join(dir, coverstore.keyFor(BOOK) + '.jpg')));
});

test('getCoverImage: second call is served from disk — no fetch, no lookup', async () => {
  const dir = tmpDir();
  await coverstore.getCoverImage({ ...BOOK, cover: 'https://x/c.jpg' }, { dir, fetchImage: async () => JPEG });
  const out = await coverstore.getCoverImage({ ...BOOK, cover: 'https://x/c.jpg' }, {
    dir,
    fetchImage: async () => { throw new Error('network used'); },
    resolveCover: async () => { throw new Error('lookup used'); },
  });
  assert.equal(out.source, 'stored');
  assert.ok(out.bytes.equals(JPEG));
});

test('getCoverImage: broken stored URL → the ePUB’s own cover', async () => {
  const dir = tmpDir();
  const book = epubWith('<manifest><item id="c" href="c.png" media-type="image/png" properties="cover-image"/></manifest>',
    [{ name: 'OEBPS/c.png', data: PNG }]);
  const out = await coverstore.getCoverImage({ ...BOOK, cover: 'https://dead/c.jpg', savePath: '/downloads/x.epub' }, {
    dir,
    fetchImage: async () => null,
    readBook: async (p) => { assert.equal(p, '/downloads/x.epub'); return book; },
    resolveCover: async () => { throw new Error('should not reach the catalogs'); },
  });
  assert.equal(out.source, 'epub');
  assert.equal(out.mime, 'image/png');
});

test('getCoverImage: no stored URL, no ePUB cover → catalog chain', async () => {
  const dir = tmpDir();
  const out = await coverstore.getCoverImage({ ...BOOK, savePath: '/downloads/x.epub' }, {
    dir,
    readBook: async () => epubWith('<manifest></manifest>'),
    resolveCover: async () => 'https://is1.mzstatic.com/a/100x100bb.jpg',
    fetchImage: async (u) => (u.includes('600x600') ? JPEG : null),
  });
  assert.equal(out.source, 'catalog');
});

test('getCoverImage: tiny/HTML "images" are rejected (Open Library 1×1 GIF, error pages)', async () => {
  const dir = tmpDir();
  const out = await coverstore.getCoverImage({ ...BOOK, cover: 'https://x/c.jpg' }, {
    dir,
    epub: false,
    fetchImage: async (u) => (u.includes('c.jpg') ? Buffer.from('GIF89a' + 'x'.repeat(40)) : Buffer.from('<html>' + 'x'.repeat(5000))),
    resolveCover: async () => 'https://y/d.jpg',
  });
  assert.equal(out.generated, true, 'neither counted as a cover');
});

test('getCoverImage: nothing anywhere → generated jacket (never blank), retried after the TTL', async () => {
  const dir = tmpDir();
  let lookups = 0;
  const opts = { dir, epub: false, fetchImage: async () => null, resolveCover: async () => { lookups++; return null; } };
  const out = await coverstore.getCoverImage(BOOK, opts);
  assert.equal(out.generated, true);
  assert.equal(out.mime, 'image/svg+xml');
  assert.ok(out.bytes.toString().includes('THE SAFE ROOM') || out.bytes.toString().includes('The Safe'));
  await coverstore.getCoverImage(BOOK, opts);
  assert.equal(lookups, 1, 'a fresh generated jacket is served from disk');
  const later = await coverstore.getCoverImage(BOOK, {
    ...opts,
    now: Date.now() + coverstore.GENERATED_TTL_MS + 1000,
    resolveCover: async () => { lookups++; return 'https://late/c.jpg'; },
    fetchImage: async () => JPEG,
  });
  assert.equal(lookups, 2);
  assert.equal(later.source, 'catalog', 'a real cover found later replaces the jacket');
  assert.ok(!fs.existsSync(path.join(dir, coverstore.keyFor(BOOK) + '.svg')), 'old jacket removed');
});

test('getCoverImage: concurrent requests for one book share one resolve', async () => {
  const dir = tmpDir();
  let fetches = 0;
  const opts = { dir, fetchImage: async () => { fetches++; await new Promise((r) => setTimeout(r, 20)); return JPEG; } };
  await Promise.all([1, 2, 3].map(() => coverstore.getCoverImage({ ...BOOK, cover: 'https://example.com/c.jpg' }, opts)));
  assert.equal(fetches, 1);
});

test('getCoverImage: an unwritable store still serves the image', async () => {
  const file = path.join(tmpDir(), 'not-a-dir');
  fs.writeFileSync(file, 'x');
  const out = await coverstore.getCoverImage({ ...BOOK, cover: 'https://x/c.jpg' }, { dir: file, fetchImage: async () => JPEG });
  assert.ok(out.bytes.equals(JPEG));
});

test('invalidate: drops the stored image so the next load re-resolves', async () => {
  const dir = tmpDir();
  await coverstore.getCoverImage({ ...BOOK, cover: 'https://x/c.jpg' }, { dir, fetchImage: async () => JPEG });
  coverstore.invalidate(BOOK, { dir });
  const out = await coverstore.getCoverImage({ ...BOOK, cover: 'https://x/new.jpg' }, { dir, fetchImage: async () => PNG });
  assert.equal(out.mime, 'image/png');
});

test('keyFor: re-downloads (same title/author, any case/punctuation) share one image', () => {
  assert.equal(coverstore.keyFor({ title: 'The Safe Room!', author: 'LISA UNGER' }), coverstore.keyFor(BOOK));
  assert.notEqual(coverstore.keyFor({ title: 'Other', author: 'Lisa Unger' }), coverstore.keyFor(BOOK));
});

// --- Image processing: normalize big covers, rasterize jackets for email ------

const sharp = require('sharp');
// A real, noisy (so it can't compress to nothing) JPEG of the given size.
async function realJpeg(w, h, quality = 95) {
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality }).toBuffer();
}

test('optimizeImage: a huge embedded cover is shrunk to fit 900×1350 as JPEG', async () => {
  const big = await realJpeg(1600, 2400);
  assert.ok(big.length > coverstore.OPTIMIZE_OVER_BYTES, `fixture is big (${big.length})`);
  const out = await coverstore.optimizeImage({ bytes: big, mime: 'image/jpeg' });
  const meta = await sharp(out.bytes).metadata();
  assert.equal(out.mime, 'image/jpeg');
  assert.ok(meta.width <= coverstore.MAX_W && meta.height <= coverstore.MAX_H, `${meta.width}x${meta.height}`);
  assert.ok(out.bytes.length < big.length / 2, `${big.length} → ${out.bytes.length}`);
});

test('optimizeImage: small covers, SVGs, corrupt bytes and a missing sharp pass through untouched', async () => {
  const small = { bytes: await realJpeg(300, 450, 70), mime: 'image/jpeg' };
  assert.equal(await coverstore.optimizeImage(small), small);
  const svg = { bytes: Buffer.from('<svg/>'), mime: 'image/svg+xml' };
  assert.equal(await coverstore.optimizeImage(svg), svg);
  const junk = { bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(500000, 3)]), mime: 'image/jpeg' };
  assert.equal(await coverstore.optimizeImage(junk), junk, 'corrupt image → unchanged, no throw');
  const big = { bytes: await realJpeg(1600, 2400), mime: 'image/jpeg' };
  assert.equal(await coverstore.optimizeImage(big, { sharp: null }), big, 'no sharp → unchanged');
});

test('getCoverImage: a newly found oversized cover is stored small', async () => {
  const dir = tmpDir();
  const big = await realJpeg(1600, 2400);
  const out = await coverstore.getCoverImage({ ...BOOK, cover: 'https://x/big.jpg' }, { dir, fetchImage: async () => big });
  const onDisk = fs.readFileSync(path.join(dir, coverstore.keyFor(BOOK) + '.jpg'));
  assert.ok(onDisk.length < big.length / 2);
  assert.ok(out.bytes.equals(onDisk));
});

test('getCoverImage: an oversized cover stored before normalizing is shrunk on next read', async () => {
  const dir = tmpDir();
  const big = await realJpeg(1600, 2400);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, coverstore.keyFor(BOOK) + '.jpg'), big);
  const out = await coverstore.getCoverImage(BOOK, { dir, fetchImage: async () => { throw new Error('no network'); } });
  assert.ok(out.bytes.length < big.length / 2);
  assert.ok(fs.readFileSync(path.join(dir, coverstore.keyFor(BOOK) + '.jpg')).length < big.length / 2, 'rewritten in place');
});

test('rasterize / getEmailCoverImage: a generated jacket becomes a PNG for email', async () => {
  const dir = tmpDir();
  const img = await coverstore.getEmailCoverImage(BOOK, { dir, epub: false, fetchImage: async () => null, resolveCover: async () => null });
  assert.equal(img.mime, 'image/png');
  assert.equal(img.bytes.readUInt32BE(0), 0x89504e47, 'PNG magic');
  assert.equal(img.generated, true);
  assert.equal((await sharp(img.bytes).metadata()).width, 600);
  // Real images pass through.
  const jpg = { bytes: JPEG, mime: 'image/jpeg' };
  assert.equal(await coverstore.rasterize(jpg), jpg);
});

test('email: a PNG cover attaches as cover.png with its real content type', () => {
  const { buildMessage } = require('../src/notify/email');
  const msg = buildMessage({ recipient: { name: 'R', email: 'r@example.com' }, book: { title: 'T', coverBuffer: Buffer.from('png-bytes'), coverMime: 'image/png' } });
  const att = (msg.attachments || [])[0];
  assert.equal(att.filename, 'cover.png');
  assert.equal(att.contentType, 'image/png');
});
