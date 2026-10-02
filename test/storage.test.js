'use strict';

// Unit + contract tests for src/storage.js (issue #47). The r2 driver only ever
// talks to the in-memory fake S3 (test/fake-s3.js) — never the network, and
// never R2_* values from process.env.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { test } = require('node:test');
const assert = require('node:assert');

const storage = require('../src/storage');
const { isSafeEpubPath } = require('../src/downloader');
const { createFakeS3 } = require('./fake-s3');

const { keyFor, savePathForKey, configFromEnv, StorageConfigError } = storage;

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bookhunt-storage-${tag}-`));
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// --- keyFor / savePathForKey (AC7) -------------------------------------------

test('keyFor: maps a book directly inside the root to books/<basename>', () => {
  assert.equal(keyFor('/dl/A [B] (2020).epub', '/dl'), 'books/A [B] (2020).epub');
  assert.equal(keyFor('/dl/x.EPUB', '/dl/'), 'books/x.EPUB');
  assert.equal(keyFor('/dl/x.pdf', '/dl'), 'books/x.pdf');
  assert.equal(keyFor('/dl/x.azw3', '/dl'), 'books/x.azw3');
  assert.equal(keyFor('/dl/x.zip', '/dl'), 'books/x.zip');
});

test('keyFor: rejects traversal, subdirs, outside paths, hidden/odd names and non-book extensions', () => {
  for (const bad of [
    '../x.epub', '/dl/../etc/x.epub', '/etc/passwd', '/other/x.epub', '/dl/sub/x.epub',
    '/dl/.hidden.epub', '/dl/x.html', '/dl/x', '', null, undefined, '/dl', '/dl/',
    '/dl/a\u0001b.epub', '/dl/a\\b.epub',
  ]) {
    assert.equal(keyFor(bad, '/dl'), null, `should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(keyFor('/dl/x.epub', ''), null);
  assert.equal(keyFor('/dl/x.epub', null), null);
});

test('keyFor: rejects an over-long basename', () => {
  assert.equal(keyFor(`/dl/${'a'.repeat(1001)}.epub`, '/dl'), null);
});

test('savePathForKey: inverse of keyFor, rejecting anything not books/<flat name>', () => {
  assert.equal(savePathForKey('books/A [B].epub', '/dl'), path.join('/dl', 'A [B].epub'));
  for (const bad of ['other/x.epub', 'books/sub/x.epub', 'books/../x.epub', 'books/', 'books/.x.epub', 'books/x.html', '', null]) {
    assert.equal(savePathForKey(bad, '/dl'), null, `should reject ${JSON.stringify(bad)}`);
  }
  const sp = savePathForKey('books/Round Trip.epub', '/dl');
  assert.equal(keyFor(sp, '/dl'), 'books/Round Trip.epub');
});

test('downloader.isSafeEpubPath (unchanged): still rejects traversal / non-epub / outside-root', () => {
  assert.equal(isSafeEpubPath('/dl/x.epub', '/dl'), true);
  assert.equal(isSafeEpubPath('/dl/../etc/x.epub', '/dl'), false);
  assert.equal(isSafeEpubPath('/dl/x.pdf', '/dl'), false);
  assert.equal(isSafeEpubPath('/other/x.epub', '/dl'), false);
  assert.equal(isSafeEpubPath('/dlx/x.epub', '/dl'), false);
  assert.equal(isSafeEpubPath('', '/dl'), false);
});

// --- configFromEnv (AC5) ------------------------------------------------------

test('configFromEnv: unset / blank / LOCAL → local', () => {
  assert.equal(configFromEnv({}).mode, 'local');
  assert.equal(configFromEnv({ STORAGE: '' }).mode, 'local');
  assert.equal(configFromEnv({ STORAGE: 'LOCAL ' }).mode, 'local');
  assert.equal(configFromEnv({ DOWNLOAD_PATH: '/x' }).root, '/x');
  assert.equal(configFromEnv({}).root, 'C:\\temp', 'same default as downloader.DOWNLOAD_PATH');
});

test('configFromEnv: STORAGE=r2 with nothing set names all four missing vars', () => {
  assert.throws(() => configFromEnv({ STORAGE: 'r2' }), (err) => {
    assert.ok(err instanceof StorageConfigError);
    assert.match(err.message, /STORAGE=r2 but required env var\(s\) are missing/);
    for (const v of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) {
      assert.ok(err.message.includes(v), `names ${v}`);
    }
    return true;
  });
});

test('configFromEnv: partially set names only the missing vars and never echoes a value', () => {
  assert.throws(
    () => configFromEnv({ STORAGE: 'r2', R2_ACCOUNT_ID: 'acct42', R2_ACCESS_KEY_ID: 'AKID99', R2_SECRET_ACCESS_KEY: 'SEKRET123', R2_BUCKET: ' ' }),
    (err) => {
      assert.ok(err instanceof StorageConfigError);
      assert.ok(err.message.includes('R2_BUCKET'));
      assert.ok(!err.message.includes('R2_ACCOUNT_ID'));
      assert.ok(!err.message.includes('R2_SECRET_ACCESS_KEY'));
      for (const secret of ['SEKRET123', 'AKID99', 'acct42']) assert.ok(!err.message.includes(secret));
      return true;
    }
  );
});

test('configFromEnv: full r2 config resolves', () => {
  const cfg = configFromEnv({
    STORAGE: ' R2', DOWNLOAD_PATH: '/downloads', R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b',
    R2_SECRET_ACCESS_KEY: 'c', R2_BUCKET: 'bookhunt-library', STORAGE_STAGING_DIR: '/stage',
  });
  assert.deepEqual(cfg, {
    mode: 'r2', root: '/downloads', accountId: 'a', accessKeyId: 'b', secretAccessKey: 'c',
    bucket: 'bookhunt-library', stagingRoot: '/stage',
  });
});

test('configFromEnv: an unknown STORAGE value throws', () => {
  assert.throws(() => configFromEnv({ STORAGE: 's3' }), /Unknown STORAGE/);
});

test('r2ConfigFromEnv: throws naming the missing vars', () => {
  assert.throws(() => storage.r2ConfigFromEnv({}), /R2_ACCESS_KEY_ID, R2_ACCOUNT_ID, R2_BUCKET, R2_SECRET_ACCESS_KEY/);
});

// --- contract suite: both drivers, same semantics (AC3 foundation) ------------

function makeLocal() {
  const root = tmpDir('local');
  const driver = storage.createLocalDriver({ root });
  return {
    driver, root,
    snapshot: () => fs.readdirSync(root).sort().join('|'),
  };
}

function makeR2() {
  const root = tmpDir('r2root'); // logical only — nothing is ever written here
  const fake = createFakeS3();
  const driver = storage.createR2Driver({ root, bucket: 'test-bucket', client: fake, stagingRoot: tmpDir('r2stage') });
  return {
    driver, root, fake,
    snapshot: () => [...fake.objects.keys()].sort().join('|'),
  };
}

for (const [name, make] of [['local', makeLocal], ['r2-fake', makeR2]]) {
  test(`contract[${name}]: put / exists / get / list / stats / attachment / remove`, async () => {
    const h = make();
    const { driver, root } = h;
    await driver.ensureIndex();
    const book = path.join(root, 'Bel Canto [Ann Patchett].epub');
    const pdf = path.join(root, 'Notes.pdf');
    const bytes = crypto.randomBytes(2048);
    const pdfBytes = crypto.randomBytes(300);

    assert.equal(driver.existsSync(book), false);
    await driver.putBuffer(bytes, book);
    await driver.putBuffer(pdfBytes, pdf);
    assert.equal(driver.existsSync(book), true);
    assert.deepEqual(await driver.getBuffer(book), bytes);

    const listed = await driver.list();
    assert.deepEqual(listed.find((e) => e.name === 'Bel Canto [Ann Patchett].epub'), {
      name: 'Bel Canto [Ann Patchett].epub', key: 'books/Bel Canto [Ann Patchett].epub', size: 2048, savePath: book,
    });
    assert.equal(listed.length, 2);

    const st = await driver.stats();
    assert.equal(st.exists, true);
    assert.equal(st.count, 1, 'only .epub counted');
    assert.equal(st.totalBytes, 2048);

    const att = await driver.attachment(book);
    if (name === 'local') assert.deepStrictEqual(att, { filePath: book });
    else assert.deepStrictEqual(att, { content: bytes });

    assert.equal(await driver.remove(book), true);
    assert.equal(driver.existsSync(book), false);
    assert.equal(await driver.remove(book), false);
  });

  test(`contract[${name}]: putFile copies a staged file to the logical path`, async () => {
    const h = make();
    const { driver, root } = h;
    await driver.ensureIndex();
    const staged = path.join(tmpDir('staged'), 'x.epub');
    const bytes = crypto.randomBytes(1500);
    fs.writeFileSync(staged, bytes);
    const dest = path.join(root, 'Dest.epub');
    await driver.putFile(staged, dest);
    assert.equal(driver.existsSync(dest), true);
    assert.deepEqual(await driver.getBuffer(dest), bytes);
    assert.ok(fs.existsSync(staged), 'the source is not consumed by the driver');
  });

  test(`contract[${name}]: put to an unsafe path rejects and writes nothing`, async () => {
    const h = make();
    const { driver, root } = h;
    const before = h.snapshot();
    for (const bad of [path.join(root, 'sub', 'x.epub'), path.join(root, '..', 'escape.epub'), path.join(root, '.hidden.epub'), path.join(root, 'page.html')]) {
      await assert.rejects(() => driver.putBuffer(Buffer.from('x'), bad), /not a valid book path/);
    }
    const src = path.join(tmpDir('src'), 'x.epub');
    fs.writeFileSync(src, 'x');
    await assert.rejects(() => driver.putFile(src, '/etc/x.epub'), /not a valid book path/);
    assert.equal(h.snapshot(), before);
    assert.ok(!fs.existsSync(path.join(root, '..', 'escape.epub')));
  });
}

test('local driver: existsSync is unscoped (any path), stagingDir is the raw root, disk/health/display', () => {
  const root = tmpDir('local-unscoped');
  const driver = storage.createLocalDriver({ root });
  const outside = path.join(tmpDir('outside'), 'x.txt');
  fs.writeFileSync(outside, 'x');
  assert.equal(driver.existsSync(outside), true);
  assert.equal(driver.existsSync(path.join(root, 'nope.epub')), false);
  assert.equal(driver.existsSync(null), false);
  assert.equal(driver.stagingDir(), root);
  assert.deepEqual(driver.healthInfo(), { mode: 'local', ok: true });
  assert.equal(driver.displayPath(), root);
  assert.equal(driver.mode, 'local');
});

// --- r2 index -------------------------------------------------------------------

function r2With(fakeOpts, seeds = []) {
  const root = tmpDir('r2idx');
  const fake = createFakeS3(fakeOpts);
  for (const [k, v] of seeds) fake.seed(k, v);
  const driver = storage.createR2Driver({ root, bucket: 'b', client: fake, stagingRoot: tmpDir('r2idx-stage') });
  return { root, fake, driver };
}

test('r2 refresh: paginates ListObjectsV2 until not truncated', async () => {
  const seeds = [1, 2, 3, 4, 5].map((i) => [`books/b${i}.epub`, `x${i}`]);
  const { fake, driver } = r2With({ pageSize: 2 }, seeds);
  await driver.refresh();
  assert.equal(fake.callsOf('ListObjectsV2Command').length, 3);
  assert.equal(driver.healthInfo().objectCount, 5);
  for (const c of fake.callsOf('ListObjectsV2Command')) {
    assert.equal(c.input.Prefix, 'books/');
    assert.equal(c.input.Bucket, 'b');
  }
});

test('r2 ensureIndex: concurrent callers share one refresh; afterwards zero calls', async () => {
  const { root, fake, driver } = r2With({}, [['books/a.epub', 'a']]);
  await Promise.all([driver.ensureIndex(), driver.ensureIndex(), driver.ensureIndex()]);
  assert.equal(fake.callsOf('ListObjectsV2Command').length, 1);
  const n = fake.calls.length;
  await driver.ensureIndex();
  assert.equal(driver.existsSync(path.join(root, 'a.epub')), true);
  assert.equal(driver.existsSync(path.join(root, 'b.epub')), false);
  assert.equal(fake.calls.length, n, 'ensureIndex after load + existsSync make zero calls');
  assert.equal(driver.healthInfo().ok, true);
  assert.equal(driver.healthInfo().indexLoaded, true);
});

test('r2 refresh: a put that lands during an in-flight refresh survives the swap', async () => {
  const { root, fake, driver } = r2With({}, [['books/old.epub', 'old']]);
  const gate = deferred();
  fake.hooks.beforeList = () => gate.promise;
  const refreshing = driver.refresh();
  await new Promise((r) => setImmediate(r)); // list call is now parked on the gate
  fake.hooks.beforeList = null;
  await driver.putBuffer(Buffer.from('new bytes'), path.join(root, 'new.epub'));
  await driver.remove(path.join(root, 'old.epub'));
  gate.resolve();
  await refreshing;
  assert.equal(driver.existsSync(path.join(root, 'new.epub')), true, 'put during refresh kept');
  assert.equal(driver.existsSync(path.join(root, 'old.epub')), false, 'delete during refresh kept');
});

test('r2 refresh failure: rejects, records lastError, keeps the previous index', async () => {
  const { root, fake, driver } = r2With({}, [['books/a.epub', 'a']]);
  await driver.refresh();
  fake.failNext('ListObjectsV2Command', new Error('boom'));
  await assert.rejects(() => driver.refresh(), /boom/);
  const h = driver.healthInfo();
  assert.equal(h.ok, false);
  assert.equal(h.lastError, 'boom');
  assert.equal(h.indexLoaded, true);
  assert.equal(driver.existsSync(path.join(root, 'a.epub')), true, 'previous index kept');
  await driver.refresh();
  assert.equal(driver.healthInfo().ok, true);
  assert.equal(driver.healthInfo().lastError, null);
});

test('r2 ensureIndex: never throws on failure, and retries while the index has never loaded', async () => {
  const { fake, driver } = r2With({}, [['books/a.epub', 'a']]);
  fake.failNext('ListObjectsV2Command', new Error('down'));
  await driver.ensureIndex();
  assert.equal(driver.healthInfo().indexLoaded, false);
  assert.equal(driver.healthInfo().lastError, 'down');
  const st = await driver.stats(); // retries
  assert.equal(st.exists, true);
  assert.equal(st.count, 1);
  assert.equal(fake.callsOf('ListObjectsV2Command').length, 2);
});

test('r2 put sends ContentMD5 + ContentType and updates the index without a list', async () => {
  const { root, fake, driver } = r2With({});
  const buf = Buffer.from('hello epub');
  await driver.putBuffer(buf, path.join(root, 'x.epub'));
  const put = fake.callsOf('PutObjectCommand')[0].input;
  assert.equal(put.Key, 'books/x.epub');
  assert.equal(put.ContentType, 'application/epub+zip');
  assert.equal(put.ContentMD5, crypto.createHash('md5').update(buf).digest('base64'));
  assert.equal(put.ContentLength, buf.length);
  assert.equal(driver.existsSync(path.join(root, 'x.epub')), true);
  assert.equal(driver.index.get('books/x.epub').etag, crypto.createHash('md5').update(buf).digest('hex'));
});

test('r2 getBuffer of a missing object rejects with a NoSuchKey-type error', async () => {
  const { root, driver } = r2With({});
  await assert.rejects(() => driver.getBuffer(path.join(root, 'nope.epub')), (err) => err.name === 'NoSuchKey');
});

test('r2 remove of an unsafe path is a no-op false with no call', async () => {
  const { fake, driver } = r2With({});
  assert.equal(await driver.remove('/etc/passwd'), false);
  assert.equal(fake.calls.length, 0);
});

test('r2 stagingDir: defaults under os.tmpdir, and refuses to alias the download root', () => {
  const root = tmpDir('alias');
  const fake = createFakeS3();
  const d1 = storage.createR2Driver({ root, bucket: 'b', client: fake });
  assert.equal(d1.stagingDir(), path.join(os.tmpdir(), 'bookhunt-staging'));
  const d2 = storage.createR2Driver({ root, bucket: 'b', client: fake, stagingRoot: root });
  assert.throws(() => d2.stagingDir(), /must not be the download directory/);
  assert.equal(d1.displayPath(), 'r2://b/books/');
  assert.equal(d1.disk(), null);
});

test('no-network guard: every r2 operation goes through the injected client', async () => {
  const { root, fake, driver } = r2With({});
  const p = path.join(root, 'g.epub');
  await driver.ensureIndex();
  await driver.putBuffer(Buffer.from('g'), p);
  await driver.getBuffer(p);
  await driver.attachment(p);
  await driver.list();
  await driver.stats();
  await driver.remove(p);
  await driver.refresh();
  assert.deepEqual(
    fake.calls.map((c) => c.op),
    ['ListObjectsV2Command', 'PutObjectCommand', 'GetObjectCommand', 'GetObjectCommand', 'DeleteObjectCommand', 'ListObjectsV2Command']
  );
});

// --- singleton -------------------------------------------------------------------

test('get(): lazily inits LOCAL in tests (STORAGE pinned), _setDriver/_reset swap it', () => {
  storage._reset();
  try {
    assert.equal(storage.get().mode, 'local');
    const fake = { mode: 'r2' };
    storage._setDriver(fake);
    assert.equal(storage.get(), fake);
  } finally {
    storage._reset();
  }
});

test('init(): throws StorageConfigError on bad config', () => {
  try {
    assert.throws(() => storage.init({ STORAGE: 'r2', R2_BUCKET: 'x' }), StorageConfigError);
  } finally {
    storage._reset();
  }
});

test('startRefreshTimer: returns an unref\'d timer that _reset clears', () => {
  const t = storage.startRefreshTimer(60000);
  try {
    assert.equal(t.hasRef(), false);
  } finally {
    storage._reset();
  }
});

// --- sweepStaging ------------------------------------------------------------------

test('sweepStaging: removes only stale dl-* dirs inside the root', () => {
  const root = tmpDir('sweep');
  const stale = path.join(root, 'dl-old');
  const fresh = path.join(root, 'dl-new');
  const other = path.join(root, 'keepme');
  fs.mkdirSync(stale);
  fs.writeFileSync(path.join(stale, 'partial.epub'), 'x');
  fs.mkdirSync(fresh);
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(root, 'dl-file.txt'), 'not a dir');
  const old = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(stale, old, old);
  fs.utimesSync(other, old, old);

  assert.equal(storage.sweepStaging(root, 3600 * 1000), 1);
  assert.ok(!fs.existsSync(stale));
  assert.ok(fs.existsSync(fresh));
  assert.ok(fs.existsSync(other));
  assert.ok(fs.existsSync(path.join(root, 'dl-file.txt')));
  assert.equal(storage.sweepStaging(path.join(root, 'missing'), 0), 0);
  assert.equal(storage.sweepStaging('', 0), 0);
});
