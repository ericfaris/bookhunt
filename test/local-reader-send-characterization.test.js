'use strict';

// Characterization tests (issue #47): pin TODAY's local-disk reader-portal send
// (reader.sendToReader) BEFORE the storage refactor. Written and passing
// against the unmodified code; must stay green, unchanged. The send throttle
// is module-level state, so each test uses its own recipient id.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-readerchar-'));
const DL = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-readerchar-dl-'));
process.env.DOWNLOAD_PATH = DL;
process.env.HISTORY_FILE = path.join(TMP, 'history.json');
process.env.RECIPIENTS_FILE = path.join(TMP, 'recipients.json');
process.env.WATCHLIST_FILE = path.join(TMP, 'watchlist.json');

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const history = require('../src/history');
const kindle = require('../src/kindle');
const reader = require('../src/reader');

let origPush;
let pushes;
beforeEach(() => {
  fs.writeFileSync(process.env.HISTORY_FILE, '[]');
  origPush = kindle.pushToKindle;
  pushes = [];
  kindle.pushToKindle = async (args) => { pushes.push(args); };
});
afterEach(() => { kindle.pushToKindle = origPush; });

function addDownload(savePath, verified = true) {
  return history.add({
    type: 'download', title: 'Reader Book', author: 'A', savePath,
    filename: path.basename(savePath), mode: 'premium', verified,
  });
}

test('local sendToReader: verified book on disk → pushes { kindleEmail, filePath: resolved, filename }', async () => {
  const p = path.join(DL, 'Reader Book [A].epub');
  fs.writeFileSync(p, 'bytes');
  const e = addDownload(p);
  const out = await reader.sendToReader({ id: 'rc1', name: 'R', kindleEmail: 'r@kindle.com' }, e.id);
  assert.deepEqual(out, { title: 'Reader Book', kindleEmail: 'r@kindle.com' });
  assert.equal(pushes.length, 1);
  assert.deepStrictEqual(pushes[0], { kindleEmail: 'r@kindle.com', filePath: path.resolve(p), filename: e.filename });
  const notifies = history.readAll().filter((x) => x.type === 'notify');
  assert.equal(notifies.length, 1);
  assert.equal(notifies[0].downloadId, e.id);
});

test('local sendToReader: missing file → rejects with code "gone", nothing pushed', async () => {
  const e = addDownload(path.join(DL, 'Missing [A].epub'));
  await assert.rejects(
    () => reader.sendToReader({ id: 'rc2', name: 'R', kindleEmail: 'r@kindle.com' }, e.id),
    (err) => err.code === 'gone'
  );
  assert.equal(pushes.length, 0);
});

test('local sendToReader: unverified download → rejects with code "gone"', async () => {
  const p = path.join(DL, 'Unverified [A].epub');
  fs.writeFileSync(p, 'bytes');
  const e = addDownload(p, false);
  await assert.rejects(
    () => reader.sendToReader({ id: 'rc3', name: 'R', kindleEmail: 'r@kindle.com' }, e.id),
    (err) => err.code === 'gone'
  );
  assert.equal(pushes.length, 0);
});

test('local sendToReader: savePath outside DOWNLOAD_PATH → rejects with code "gone"', async () => {
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-readerchar-out-')), 'x.epub');
  fs.writeFileSync(outside, 'bytes');
  const e = addDownload(outside);
  await assert.rejects(
    () => reader.sendToReader({ id: 'rc4', name: 'R', kindleEmail: 'r@kindle.com' }, e.id),
    (err) => err.code === 'gone'
  );
  assert.equal(pushes.length, 0);
});
