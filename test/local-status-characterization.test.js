'use strict';

// Characterization tests (issue #47): pin TODAY's local-disk /api/status
// `download` block and the /healthz body BEFORE the storage refactor. Written
// and passing against the unmodified code; must stay green, unchanged.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-statuschar-'));
const DL = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-statuschar-dl-'));
process.env.DOWNLOAD_PATH = DL;
process.env.HISTORY_FILE = path.join(TMP, 'history.json');
process.env.RECIPIENTS_FILE = path.join(TMP, 'recipients.json');
process.env.WATCHLIST_FILE = path.join(TMP, 'watchlist.json');
process.env.CF_ACCESS_TEAM_DOMAIN = '';
process.env.CF_ACCESS_AUD = '';

const { test } = require('node:test');
const assert = require('node:assert');

const searcher = require('../src/searcher');
const health = require('../src/health');
const { app } = require('../src/server');
const { request, withServer } = require('./http-helpers');

fs.writeFileSync(path.join(DL, 'One.epub'), Buffer.alloc(1500, 1));
fs.writeFileSync(path.join(DL, 'Two.EPUB'), Buffer.alloc(2500, 2));
fs.writeFileSync(path.join(DL, 'notes.txt'), Buffer.alloc(999, 3));

test('local GET /api/status: download block is exactly { path, exists, count, totalBytes, disk }', async () => {
  const origStatus = searcher.sessionStatus;
  searcher.sessionStatus = async () => ({ browser: false, ready: false, loggedIn: false, cfOk: false });
  try {
    await withServer(app, async (port) => {
      const { status, json } = await request(port, 'GET', '/api/status');
      assert.equal(status, 200);
      const d = json.download;
      assert.deepEqual(Object.keys(d).sort(), ['count', 'disk', 'exists', 'path', 'totalBytes']);
      assert.equal(d.path, DL);
      assert.equal(d.exists, true);
      assert.equal(d.count, 2);
      assert.equal(d.totalBytes, 4000);
      const expectDisk = health.freeSpace(DL);
      if (expectDisk === null) assert.equal(d.disk, null);
      else {
        assert.equal(typeof d.disk.freeBytes, 'number');
        assert.equal(typeof d.disk.totalBytes, 'number');
      }
      assert.equal(json.storage, undefined);
      assert.deepEqual(json.session, { browser: false, ready: false, loggedIn: false, cfOk: false });
    });
  } finally {
    searcher.sessionStatus = origStatus;
  }
});

test('local GET /healthz: body is exactly { ok: true }', async () => {
  await withServer(app, async (port) => {
    const { status, json } = await request(port, 'GET', '/healthz');
    assert.equal(status, 200);
    assert.deepStrictEqual(json, { ok: true });
  });
});
