'use strict';

// Download pipeline in r2 storage mode (issue #47): files are saved/extracted
// in a per-attempt staging dir, only the final verified book is uploaded under
// books/<filename>, the returned savePath is the LOGICAL DOWNLOAD_PATH path,
// and the staging dir is always removed — on success and on every failure.
// The r2 driver talks only to the in-memory fake S3.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DL = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-dlstore-dl-'));
process.env.DOWNLOAD_PATH = DL;

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const storage = require('../src/storage');
const downloader = require('../src/downloader');
const { parseEpubBuffer } = require('../src/epub');
const { epubBuffer, storedZip } = require('./helpers');
const { createFakeS3 } = require('./fake-s3');

const { withStaging, saveDownloadEvent, saveViaRequest, finalizeDownload, runMirrors, runCandidates, discardFile } = downloader;
const RAR_FIXTURE = path.join(__dirname, 'fixtures', 'book.rar');
const META = { title: 'Bel Canto', author: 'Ann Patchett' };
const NAME = 'Bel Canto [Ann Patchett].epub';

function useR2() {
  const fake = createFakeS3();
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-dlstore-stage-'));
  const driver = storage.createR2Driver({ root: DL, bucket: 'b', client: fake, stagingRoot });
  storage._setDriver(driver);
  return { fake, stagingRoot, driver };
}

afterEach(() => storage._reset());

function fakeDownload(name, writer) {
  return { suggestedFilename: () => name, saveAs: async (p) => writer(p) };
}

const dlEntries = () => fs.readdirSync(DL);

// --- success paths (AC2) -------------------------------------------------------

test('r2: download event → uploaded under books/, logical savePath, staging emptied, nothing in DOWNLOAD_PATH', async () => {
  const { fake, stagingRoot } = useR2();
  const bytes = epubBuffer('Bel Canto', 'Ann Patchett');
  const before = dlEntries();
  const rec = await withStaging(storage.get(), (dir) =>
    saveDownloadEvent(fakeDownload('host-name.epub', (p) => fs.writeFileSync(p, bytes)), META, dir)
  );
  assert.equal(rec.savePath, path.join(DL, NAME));
  assert.equal(rec.filename, NAME);
  assert.equal(rec.verified, true);
  assert.equal(rec.titleMatch, true);
  assert.ok(fake.objects.has(`books/${NAME}`));
  assert.deepEqual(fake.objects.get(`books/${NAME}`).body, bytes);
  assert.deepEqual(fs.readdirSync(stagingRoot), [], 'staging root is empty');
  assert.deepEqual(dlEntries(), before, 'nothing written to DOWNLOAD_PATH');
  assert.equal(storage.get().existsSync(rec.savePath), true, 'index updated by the upload');
});

test('r2: a ZIP-wrapped epub uploads the INNER epub only', async () => {
  const { fake, stagingRoot } = useR2();
  const zip = storedZip([{ name: 'inner.epub', data: epubBuffer('Bel Canto', 'Ann Patchett') }]);
  const rec = await withStaging(storage.get(), (dir) =>
    saveDownloadEvent(fakeDownload('release.zip', (p) => fs.writeFileSync(p, zip)), META, dir)
  );
  assert.equal(rec.savePath, path.join(DL, NAME));
  assert.deepEqual([...fake.objects.keys()], [`books/${NAME}`], 'no archive object uploaded');
  assert.equal(parseEpubBuffer(fake.objects.get(`books/${NAME}`).body).title, 'Bel Canto');
  assert.ok(!fake.callsOf('PutObjectCommand').some((c) => /\.zip$/i.test(c.input.Key)));
  assert.deepEqual(fs.readdirSync(stagingRoot), []);
});

test('r2: a RAR-wrapped epub uploads the INNER epub only', async () => {
  const { fake, stagingRoot } = useR2();
  const meta = { title: 'The Great Book', author: 'X' };
  const rec = await withStaging(storage.get(), (dir) =>
    saveDownloadEvent(fakeDownload('release.rar', (p) => fs.copyFileSync(RAR_FIXTURE, p)), meta, dir)
  );
  assert.equal(rec.savePath, path.join(DL, rec.filename));
  assert.ok(rec.filename.toLowerCase().endsWith('.epub'));
  assert.deepEqual([...fake.objects.keys()], [`books/${rec.filename}`]);
  assert.equal(parseEpubBuffer(fake.objects.get(`books/${rec.filename}`).body).title, 'The Great Book');
  assert.deepEqual(fs.readdirSync(stagingRoot), []);
});

test('r2: saveViaRequest + finalizeDownload inside withStaging uploads, staging emptied', async () => {
  const { fake, stagingRoot } = useR2();
  const bytes = epubBuffer('Bel Canto', 'Ann Patchett');
  const page = { context: () => ({ request: { get: async () => ({ ok: () => true, body: async () => bytes }) } }) };
  let stagedPath = null;
  const rec = await withStaging(storage.get(), async (dir) => {
    const saved = await saveViaRequest(page, 'https://host/app/files/Some%20Host%20Name.epub', META, dir);
    stagedPath = saved.savePath;
    assert.equal(path.dirname(saved.savePath), dir, 'saved into the staging dir');
    return finalizeDownload(saved.savePath, saved.filename, META, () => {}, { dir });
  });
  assert.equal(rec.savePath, path.join(DL, NAME));
  assert.deepEqual(fake.objects.get(`books/${NAME}`).body, bytes);
  assert.ok(!fs.existsSync(stagedPath));
  assert.deepEqual(fs.readdirSync(stagingRoot), []);
});

test('r2: progress events are unchanged (no new steps for the upload)', async () => {
  useR2();
  const steps = [];
  await withStaging(storage.get(), (dir) =>
    saveDownloadEvent(fakeDownload('x.epub', (p) => fs.writeFileSync(p, epubBuffer('Bel Canto', 'Ann Patchett'))), META, dir, (e) => steps.push(e.step))
  );
  assert.deepEqual(steps, ['saved', 'verifying', 'verified']);
});

// --- failure paths (AC2) ---------------------------------------------------------

test('r2: an HTML page served as the download → rejects, no object, staging emptied', async () => {
  const { fake, stagingRoot } = useR2();
  const html = '<html><head><title>Not Found</title></head><body>' + 'x'.repeat(2000) + '</body></html>';
  await assert.rejects(
    () => withStaging(storage.get(), (dir) => saveDownloadEvent(fakeDownload('x.epub', (p) => fs.writeFileSync(p, html)), META, dir)),
    /Not Found/
  );
  assert.equal(fake.objects.size, 0);
  assert.equal(fake.callsOf('PutObjectCommand').length, 0);
  assert.deepEqual(fs.readdirSync(stagingRoot), []);
});

test('r2: a ZIP with no epub inside → rejects, no object, staging emptied', async () => {
  const { fake, stagingRoot } = useR2();
  const zip = storedZip([{ name: 'cover.jpg', data: Buffer.alloc(2000) }]);
  await assert.rejects(
    () => withStaging(storage.get(), (dir) => saveDownloadEvent(fakeDownload('x.zip', (p) => fs.writeFileSync(p, zip)), META, dir)),
    /No EPUB found inside the ZIP/
  );
  assert.equal(fake.objects.size, 0);
  assert.deepEqual(fs.readdirSync(stagingRoot), []);
});

test('r2: an upload failure rejects the attempt and staging is still emptied', async () => {
  const { fake, stagingRoot } = useR2();
  fake.failNext('PutObjectCommand', new Error('r2 down'));
  await assert.rejects(
    () => withStaging(storage.get(), (dir) =>
      saveDownloadEvent(fakeDownload('x.epub', (p) => fs.writeFileSync(p, epubBuffer('Bel Canto', 'Ann Patchett'))), META, dir)),
    /r2 down/
  );
  assert.equal(fake.objects.size, 0);
  assert.equal(storage.get().existsSync(path.join(DL, NAME)), false);
  assert.deepEqual(fs.readdirSync(stagingRoot), []);
});

test('r2: saveAs writing a partial file then throwing leaves no staging residue', async () => {
  const { fake, stagingRoot } = useR2();
  await assert.rejects(
    () => withStaging(storage.get(), (dir) =>
      saveDownloadEvent(fakeDownload('x.epub', (p) => { fs.writeFileSync(p, 'partial'); throw new Error('connection reset'); }), META, dir)),
    /connection reset/
  );
  assert.equal(fake.objects.size, 0);
  assert.deepEqual(fs.readdirSync(stagingRoot), []);
});

test('r2: each attempt gets its own dl-* staging dir under the staging root', async () => {
  const { stagingRoot } = useR2();
  const seen = [];
  await withStaging(storage.get(), async (dir) => { seen.push(dir); });
  await withStaging(storage.get(), async (dir) => { seen.push(dir); });
  assert.notEqual(seen[0], seen[1]);
  for (const d of seen) {
    assert.equal(path.dirname(d), stagingRoot);
    assert.ok(path.basename(d).startsWith('dl-'));
    assert.ok(!fs.existsSync(d));
  }
});

test('r2: withStaging refuses a staging root equal to DOWNLOAD_PATH (never rm the library)', async () => {
  const fake = createFakeS3();
  const bad = { mode: 'r2', stagingDir: () => DL };
  storage._setDriver(storage.createR2Driver({ root: DL, bucket: 'b', client: fake }));
  const marker = path.join(DL, 'keep-me.txt');
  fs.writeFileSync(marker, 'x');
  await assert.rejects(() => withStaging(bad, async () => 'ran'), /Refusing to stage/);
  assert.ok(fs.existsSync(marker));
  fs.unlinkSync(marker);
});

// --- dedupe in r2 mode (mirrors test/mirrors.test.js cases with logical paths) ----

const links = [{ url: 'a', host: 'h1' }, { url: 'b', host: 'h2' }, { url: 'c', host: 'h3' }];

function scripted(steps) {
  let i = 0;
  return async () => {
    const s = steps[i++];
    if (s.throw) throw s.throw;
    return s.file;
  };
}

test('r2 runMirrors: a superseded fallback at the SAME savePath as the winner keeps the object', async () => {
  const { fake } = useR2();
  const shared = path.join(DL, 'book.epub');
  fake.seed('books/book.epub', 'winner bytes');
  await storage.get().refresh();
  const { downloads } = await runMirrors(links, scripted([
    { file: { filename: 'book.epub', savePath: shared, verified: false } },
    { file: { filename: 'book.epub', savePath: shared, verified: true, titleMatch: true } },
  ]));
  assert.equal(downloads[0].verified, true);
  assert.ok(fake.objects.has('books/book.epub'), 'winner object survives');
  assert.equal(fake.callsOf('DeleteObjectCommand').length, 0);
});

test('r2 runMirrors: a superseded fallback at a DIFFERENT savePath is deleted and unindexed', async () => {
  const { fake } = useR2();
  fake.seed('books/loser.epub', 'loser');
  fake.seed('books/winner.epub', 'winner');
  await storage.get().refresh();
  await runMirrors(links, scripted([
    { file: { filename: 'loser.epub', savePath: path.join(DL, 'loser.epub'), verified: false } },
    { file: { filename: 'winner.epub', savePath: path.join(DL, 'winner.epub'), verified: true, titleMatch: true } },
  ]));
  assert.ok(!fake.objects.has('books/loser.epub'));
  assert.ok(fake.objects.has('books/winner.epub'));
  assert.equal(storage.get().existsSync(path.join(DL, 'loser.epub')), false);
  assert.equal(storage.get().existsSync(path.join(DL, 'winner.epub')), true);
});

test('r2 runMirrors: a fatal abort deletes the fallback object', async () => {
  const { fake } = useR2();
  fake.seed('books/fb.epub', 'fallback');
  await storage.get().refresh();
  const fatal = Object.assign(new Error('account expired'), { fatal: true });
  await assert.rejects(() => runMirrors(links, scripted([
    { file: { filename: 'fb.epub', savePath: path.join(DL, 'fb.epub'), verified: false } },
    { throw: fatal },
  ])), /account expired/);
  assert.ok(!fake.objects.has('books/fb.epub'));
});

test('r2 runCandidates: replacing a fallback at a different path deletes it; same path survives', async () => {
  const { fake } = useR2();
  fake.seed('books/bad.epub', 'bad');
  fake.seed('books/good.epub', 'good');
  await storage.get().refresh();
  const posts = [{ url: 'p1', title: 'P1' }, { url: 'p2', title: 'P2' }];
  const results = [
    { downloads: [{ filename: 'bad.epub', savePath: path.join(DL, 'bad.epub'), verified: false }], errors: [] },
    { downloads: [{ filename: 'good.epub', savePath: path.join(DL, 'good.epub'), verified: true, titleMatch: true }], errors: [] },
  ];
  let i = 0;
  const { result } = await runCandidates(posts, async () => results[i++]);
  assert.equal(result.downloads[0].filename, 'good.epub');
  assert.ok(!fake.objects.has('books/bad.epub'));
  assert.ok(fake.objects.has('books/good.epub'));
});

test('r2 discardFile: removes the object; an unsafe path is a silent no-op', async () => {
  const { fake } = useR2();
  fake.seed('books/z.epub', 'z');
  await discardFile(path.join(DL, 'z.epub'));
  assert.ok(!fake.objects.has('books/z.epub'));
  await discardFile('/etc/passwd'); // must not throw
});

// --- local regression ---------------------------------------------------------------

test('local: withStaging passes DOWNLOAD_PATH itself and removes nothing', async () => {
  storage._reset();
  assert.equal(storage.get().mode, 'local');
  const marker = path.join(DL, 'local-marker.epub');
  fs.writeFileSync(marker, 'x');
  let got = null;
  const out = await withStaging(storage.get(), async (dir) => { got = dir; return 'done'; });
  assert.equal(out, 'done');
  assert.equal(got, downloader.DOWNLOAD_PATH);
  assert.ok(fs.existsSync(marker));
  fs.unlinkSync(marker);
});

test('local: finalizeDownload returns the staged path itself (no copy/upload)', async () => {
  storage._reset();
  const p = path.join(DL, 'Local [A].epub');
  fs.writeFileSync(p, epubBuffer('Local', 'A'));
  const rec = await finalizeDownload(p, 'Local [A].epub', { title: 'Local', author: 'A' });
  assert.equal(rec.savePath, p);
  assert.equal(rec.verified, true);
  fs.unlinkSync(p);
});

test('local: discardFile unlinks a tmp file OUTSIDE any root (unscoped, as mirrors relies on)', async () => {
  storage._reset();
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-dlstore-out-')), 'x.epub');
  fs.writeFileSync(p, 'x');
  await discardFile(p);
  assert.ok(!fs.existsSync(p));
  await discardFile(p); // missing → still no throw
});

test('local: saveViaRequest defaults to DOWNLOAD_PATH', async () => {
  storage._reset();
  const bytes = epubBuffer('Bel Canto', 'Ann Patchett');
  const page = { context: () => ({ request: { get: async () => ({ ok: () => true, body: async () => bytes }) } }) };
  const saved = await saveViaRequest(page, 'https://host/files/x.epub', META);
  assert.equal(saved.savePath, path.join(DL, NAME));
  assert.ok(fs.existsSync(saved.savePath));
  fs.unlinkSync(saved.savePath);
});
