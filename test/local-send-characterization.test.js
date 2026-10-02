'use strict';

// Characterization tests (issue #47): pin TODAY's local-disk Send-to-Kindle
// behaviour (POST /api/send + kindle.pushToKindle) BEFORE the storage refactor.
// Written and passing against the unmodified code; must stay green, unchanged.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-sendchar-'));
const DL = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-sendchar-dl-'));
process.env.DOWNLOAD_PATH = DL;
process.env.HISTORY_FILE = path.join(TMP, 'history.json');
process.env.RECIPIENTS_FILE = path.join(TMP, 'recipients.json');
process.env.WATCHLIST_FILE = path.join(TMP, 'watchlist.json');
process.env.CF_ACCESS_TEAM_DOMAIN = '';
process.env.CF_ACCESS_AUD = '';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const history = require('../src/history');
const recipients = require('../src/recipients');
const kindle = require('../src/kindle');
const notify = require('../src/notify');
const covers = require('../src/covers');
const smtp = require('../src/smtp');
const { app } = require('../src/server');
const { request, withServer } = require('./http-helpers');

let orig;
let pushes;
beforeEach(() => {
  fs.writeFileSync(process.env.HISTORY_FILE, '[]');
  orig = {
    byIds: recipients.byIds,
    push: kindle.pushToKindle,
    notify: notify.notify,
    resolveCover: covers.resolveCover,
    resolveMeta: covers.resolveMeta,
  };
  pushes = [];
  recipients.byIds = () => [{ id: 'r1', name: 'A', kindleEmail: 'a@kindle.com' }];
  kindle.pushToKindle = async (args) => { pushes.push(args); };
  notify.notify = async () => [];
  covers.resolveCover = async () => null;
  covers.resolveMeta = async () => ({});
});
afterEach(() => {
  recipients.byIds = orig.byIds;
  kindle.pushToKindle = orig.push;
  notify.notify = orig.notify;
  covers.resolveCover = orig.resolveCover;
  covers.resolveMeta = orig.resolveMeta;
});

function addDownload(savePath) {
  return history.add({
    type: 'download', title: 'Book', author: 'A', savePath,
    filename: path.basename(savePath), mode: 'premium', verified: true,
  });
}

test('local POST /api/send: pushes exactly { kindleEmail, filePath: resolved, filename }', async () => {
  const p = path.join(DL, 'Send Me [A].epub');
  fs.writeFileSync(p, 'bytes');
  const e = addDownload(p);
  await withServer(app, async (port) => {
    const { status, json } = await request(port, 'POST', '/api/send', { downloadId: e.id, recipientIds: ['r1'] });
    assert.equal(status, 200);
    assert.equal(json.results.length, 1);
    assert.deepEqual(json.results[0].kindle, { ok: true });
  });
  assert.equal(pushes.length, 1);
  assert.deepStrictEqual(pushes[0], { kindleEmail: 'a@kindle.com', filePath: path.resolve(p), filename: e.filename });
});

test('local POST /api/send: missing file → 410', async () => {
  const e = addDownload(path.join(DL, 'Gone [A].epub'));
  await withServer(app, async (port) => {
    const { status, json } = await request(port, 'POST', '/api/send', { downloadId: e.id, recipientIds: ['r1'] });
    assert.equal(status, 410);
    assert.equal(json.error, 'File no longer exists on disk.');
  });
  assert.equal(pushes.length, 0);
});

test('local POST /api/send: a non-epub savePath → 400', async () => {
  const p = path.join(DL, 'notes.txt');
  fs.writeFileSync(p, 'bytes');
  const e = addDownload(p);
  await withServer(app, async (port) => {
    const { status } = await request(port, 'POST', '/api/send', { downloadId: e.id, recipientIds: ['r1'] });
    assert.equal(status, 400);
  });
  assert.equal(pushes.length, 0);
});

test('local POST /api/send: unknown download id → 404', async () => {
  await withServer(app, async (port) => {
    const { status } = await request(port, 'POST', '/api/send', { downloadId: 'nope', recipientIds: ['r1'] });
    assert.equal(status, 404);
  });
});

test('kindle.pushToKindle (file path): attachment is { filename, path, contentType }', async () => {
  kindle.pushToKindle = orig.push; // the real one
  const origTransport = smtp.getTransport;
  let captured = null;
  smtp.getTransport = () => ({ sendMail: async (m) => { captured = m; } });
  try {
    await kindle.pushToKindle({ kindleEmail: 'k@kindle.com', filePath: '/some/x.epub', filename: 'x.epub' });
  } finally {
    smtp.getTransport = origTransport;
  }
  assert.deepStrictEqual(captured.attachments, [
    { filename: 'x.epub', path: '/some/x.epub', contentType: 'application/epub+zip' },
  ]);
  assert.equal(captured.to, 'k@kindle.com');
  assert.equal(captured.from, smtp.FROM);
  assert.equal(captured.subject, 'x.epub');
  assert.equal(captured.text, 'Sent from BookHunt');
});

test('kindle.pushToKindle (file path): filename defaults to the path basename', async () => {
  kindle.pushToKindle = orig.push;
  const origTransport = smtp.getTransport;
  let captured = null;
  smtp.getTransport = () => ({ sendMail: async (m) => { captured = m; } });
  try {
    await kindle.pushToKindle({ kindleEmail: 'k@kindle.com', filePath: '/some/y.epub' });
  } finally {
    smtp.getTransport = origTransport;
  }
  assert.equal(captured.subject, 'y.epub');
  assert.equal(captured.attachments[0].filename, 'y.epub');
});

test('kindle.pushToKindle: no Kindle email → throws', async () => {
  kindle.pushToKindle = orig.push;
  await assert.rejects(() => kindle.pushToKindle({ filePath: '/x.epub' }), /No Kindle email/);
});
