'use strict';

// scripts/migrate-to-r2.js (issue #47, AC6): dry-run by default, idempotent
// apply with verification, and it NEVER touches local files. The driver talks
// only to the in-memory fake S3; dotenv is never loaded (only main() does).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { test } = require('node:test');
const assert = require('node:assert');

const storage = require('../src/storage');
const { createFakeS3 } = require('./fake-s3');
const { migrate, parseArgs } = require('../scripts/migrate-to-r2');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'migrate-to-r2.js');
const quiet = () => {};

function setup() {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-migrate-'));
  const files = {
    'Alpha [A].epub': crypto.randomBytes(3000),
    'Beta [B] (2020).epub': crypto.randomBytes(1500),
    'Gamma.EPUB': crypto.randomBytes(2200),
    'notes.txt': Buffer.from('not a book'),
    '.hidden.epub': crypto.randomBytes(100),
  };
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(srcDir, n), b);
  fs.mkdirSync(path.join(srcDir, 'subdir'));
  const fake = createFakeS3();
  const driver = storage.createR2Driver({ root: srcDir, bucket: 't', client: fake });
  return { srcDir, files, fake, driver };
}

function snapshot(dir) {
  return fs.readdirSync(dir).sort().map((name) => {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    const sha = st.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'dir';
    return { name, size: st.size, mtimeMs: st.mtimeMs, sha };
  });
}

const BOOKS = ['Alpha [A].epub', 'Beta [B] (2020).epub', 'Gamma.EPUB'];

test('migrate dry run: plans 3 uploads, makes only list calls, writes nothing anywhere', async () => {
  const { srcDir, fake, driver } = setup();
  const before = snapshot(srcDir);
  const lines = [];
  const res = await migrate({ srcDir, driver, log: (l) => lines.push(l) });
  assert.equal(res.planned, 3);
  assert.equal(res.ignored, 2, '.txt and .hidden.epub ignored');
  assert.equal(res.uploaded, 0);
  assert.ok(fake.calls.every((c) => c.op === 'ListObjectsV2Command'));
  assert.equal(fake.objects.size, 0);
  assert.ok(lines.some((l) => l.includes('DRY RUN — nothing written')));
  assert.deepEqual(snapshot(srcDir), before);
});

test('migrate --apply: uploads 3 objects byte-for-byte and verifies them', async () => {
  const { srcDir, files, fake, driver } = setup();
  const before = snapshot(srcDir);
  const res = await migrate({ srcDir, driver, apply: true, log: quiet });
  assert.equal(res.uploaded, 3);
  assert.equal(res.failed, 0);
  assert.equal(res.verified, 3);
  assert.equal(res.mismatched, 0);
  assert.deepEqual([...fake.objects.keys()].sort(), BOOKS.map((n) => `books/${n}`).sort());
  for (const n of BOOKS) assert.deepEqual(fake.objects.get(`books/${n}`).body, files[n]);
  assert.ok(fake.callsOf('PutObjectCommand').every((c) => c.input.ContentMD5), 'Content-MD5 sent');
  assert.equal(fake.callsOf('DeleteObjectCommand').length, 0);
  assert.deepEqual(snapshot(srcDir), before, 'local files untouched (bytes + mtime + listing)');
});

test('migrate re-run: everything skipped, no PutObject', async () => {
  const { srcDir, fake, driver } = setup();
  await migrate({ srcDir, driver, apply: true, log: quiet });
  const n = fake.calls.length;
  const res = await migrate({ srcDir, driver, apply: true, log: quiet });
  assert.equal(res.skipped, 3);
  assert.equal(res.uploaded, 0);
  assert.equal(res.planned, 0);
  assert.equal(res.verified, 3);
  assert.equal(fake.calls.slice(n).filter((c) => c.op === 'PutObjectCommand').length, 0);
});

test('migrate: a same-size object is skipped; a different-size object is replaced', async () => {
  const { srcDir, files, fake, driver } = setup();
  fake.seed('books/Alpha [A].epub', files['Alpha [A].epub']);
  fake.seed('books/Beta [B] (2020).epub', Buffer.from('short'));
  const res = await migrate({ srcDir, driver, apply: true, log: quiet });
  assert.equal(res.skipped, 1);
  assert.equal(res.replaced, 1);
  assert.equal(res.uploaded, 1);
  assert.equal(res.mismatched, 0);
  assert.deepEqual(fake.objects.get('books/Beta [B] (2020).epub').body, files['Beta [B] (2020).epub']);
});

test('migrate verify: a wrong ETag for one key counts as a mismatch', async () => {
  const { srcDir, fake, driver } = setup();
  fake.hooks.listEtag = (key, etag) => (key === 'books/Gamma.EPUB' ? '"00000000000000000000000000000000"' : etag);
  const res = await migrate({ srcDir, driver, apply: true, log: quiet });
  assert.equal(res.mismatched, 1);
  assert.equal(res.verified, 2);
});

test('migrate verify: a multipart-style ETag (with "-") falls back to size only', async () => {
  const { srcDir, fake, driver } = setup();
  fake.hooks.listEtag = () => '"abc-2"';
  const res = await migrate({ srcDir, driver, apply: true, log: quiet });
  assert.equal(res.mismatched, 0);
  assert.equal(res.verified, 3);
});

test('migrate: a put failure is counted and the other files still upload', async () => {
  const { srcDir, fake, driver } = setup();
  fake.failNext('PutObjectCommand', new Error('r2 hiccup'));
  const lines = [];
  const res = await migrate({ srcDir, driver, apply: true, log: (l) => lines.push(l) });
  assert.equal(res.failed, 1);
  assert.equal(res.uploaded, 2);
  assert.equal(fake.objects.size, 2);
  assert.equal(res.mismatched, 1, 'the failed one is missing at verify');
  assert.ok(lines.some((l) => l.includes('FAILED') && l.includes('r2 hiccup')));
});

test('migrate never touches local files (snapshot across dry run AND apply) and never deletes remotely', async () => {
  const { srcDir, fake, driver } = setup();
  const before = snapshot(srcDir);
  await migrate({ srcDir, driver, log: quiet });
  assert.deepEqual(snapshot(srcDir), before);
  await migrate({ srcDir, driver, apply: true, log: quiet });
  assert.deepEqual(snapshot(srcDir), before);
  assert.equal(fake.callsOf('DeleteObjectCommand').length, 0);
});

test('migrate script source: no delete/move/write primitives at all (static guard)', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(src, /\b(unlink|unlinkSync|rmSync|rmdirSync|renameSync|writeFileSync|DeleteObject)\b|\.remove\(/);
  assert.doesNotMatch(src, /console\.log\([^)]*R2_(SECRET|ACCESS|ACCOUNT)/, 'never logs credentials');
});

test('parseArgs: defaults to dry run; --apply and --src parse; unknown args throw', () => {
  assert.deepEqual(parseArgs([]), { apply: false, src: null, help: false });
  assert.equal(parseArgs(['--apply']).apply, true);
  assert.equal(parseArgs(['--src', '/mnt/c/epubs']).src, '/mnt/c/epubs');
  assert.equal(parseArgs(['--src=/x']).src, '/x');
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['--src']), /needs a directory/);
  assert.throws(() => parseArgs(['--yolo']), /Unknown argument/);
});

test('r2ConfigFromEnv: missing config throws naming the missing vars', () => {
  assert.throws(() => storage.r2ConfigFromEnv({}), (err) => {
    for (const v of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) assert.ok(err.message.includes(v));
    return true;
  });
});

test('CLI: missing R2 config exits 2 naming the vars; a bad --src exits 2 (no .env, no network)', { timeout: 15000 }, () => {
  const { spawnSync } = require('node:child_process');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-migrate-cli-'));
  const env = { PATH: process.env.PATH, HOME: cwd };
  const noCfg = spawnSync(process.execPath, [SCRIPT, '--src', cwd], { cwd, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(noCfg.status, 2);
  assert.match(noCfg.stderr, /R2_BUCKET/);
  const badSrc = spawnSync(process.execPath, [SCRIPT, '--src', path.join(cwd, 'nope')], { cwd, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(badSrc.status, 2);
  assert.match(badSrc.stderr, /Cannot read source directory/);
  const badArg = spawnSync(process.execPath, [SCRIPT, '--yolo'], { cwd, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(badArg.status, 2);
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { cwd, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage/);
});
