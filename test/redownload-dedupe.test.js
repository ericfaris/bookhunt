'use strict';

// A second click on a finished download used to log a duplicate "Downloaded"
// line (and the Kindle send line showed the raw search-box text). Pins:
//  - logDownload refreshes a recent same-file entry instead of appending one
//  - /api/send logs/emails the stored (cleaned) title, not the client's copy
//  - the search-result button is marked done after a successful download
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-redl-'));
const DL = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-redl-dl-'));
process.env.DOWNLOAD_PATH = DL;
process.env.HISTORY_FILE = path.join(TMP, 'history.json');
process.env.RECIPIENTS_FILE = path.join(TMP, 'recipients.json');
process.env.WATCHLIST_FILE = path.join(TMP, 'watchlist.json');
process.env.CF_ACCESS_TEAM_DOMAIN = '';
process.env.CF_ACCESS_AUD = '';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const history = require('../src/history');

const DL_ARGS = {
  title: 'every summer after', author: 'Carley Fortune',
  filename: 'every summer after [Carley Fortune].epub',
  savePath: '/downloads/every summer after [Carley Fortune].epub',
  url: 'https://filedot.to/q6k0vmidqcpd', mode: 'premium', verified: true, size: 100,
};

beforeEach(() => fs.writeFileSync(process.env.HISTORY_FILE, '[]'));

const downloads = () => history.readAll().filter((e) => e.type === 'download');

test('re-downloading the same file moments later keeps ONE entry, same id, refreshed fields', () => {
  const first = history.logDownload(DL_ARGS);
  history.logNotify({ downloadId: first.id, title: first.title, filename: first.filename, to: ['Joyce'] });
  const second = history.logDownload({ ...DL_ARGS, size: 200 });
  assert.equal(second.id, first.id);
  const dls = downloads();
  assert.equal(dls.length, 1);
  assert.equal(dls[0].size, 200);
  assert.equal(dls[0].title, 'Every Summer After');
  // the earlier send still points at a real download
  const n = history.readAll().find((e) => e.type === 'notify');
  assert.ok(dls.some((d) => d.id === n.downloadId));
});

test('a different file, link, or an old entry still logs a new download', () => {
  history.logDownload(DL_ARGS);
  history.logDownload({ ...DL_ARGS, url: 'https://other.host/x' });
  history.logDownload({ ...DL_ARGS, filename: 'b.epub', savePath: '/downloads/b.epub' });
  assert.equal(downloads().length, 3);

  // age every entry past the window → a repeat is a fresh download again
  const old = new Date(Date.now() - history.REDOWNLOAD_WINDOW_MS - 1000).toISOString();
  history.mutate((es) => { es.forEach((e) => { e.timestamp = old; }); });
  history.logDownload(DL_ARGS);
  assert.equal(downloads().length, 4);
});

test('distinct books from one archive (different savePaths) are each logged', () => {
  history.logDownload({ ...DL_ARGS, filename: 'one.epub', savePath: '/downloads/one.epub' });
  history.logDownload({ ...DL_ARGS, filename: 'two.epub', savePath: '/downloads/two.epub' });
  assert.equal(downloads().length, 2);
});

test('/api/send logs the stored cleaned title, not the raw client title', async () => {
  const recipients = require('../src/recipients');
  const kindle = require('../src/kindle');
  const notify = require('../src/notify');
  const covers = require('../src/covers');
  const { app } = require('../src/server');
  const { request, withServer } = require('./http-helpers');
  const orig = { byIds: recipients.byIds, push: kindle.pushToKindle, notify: notify.notify, rc: covers.resolveCover, rm: covers.resolveMeta };
  let notified = null;
  recipients.byIds = () => [{ id: 'r1', name: 'Joyce', kindleEmail: 'j@kindle.com' }];
  kindle.pushToKindle = async () => {};
  notify.notify = async (_r, info) => { notified = info; return []; };
  covers.resolveCover = async () => null;
  covers.resolveMeta = async () => ({});
  try {
    const p = path.join(DL, 'every summer after [Carley Fortune].epub');
    fs.writeFileSync(p, 'bytes');
    const e = history.logDownload({ ...DL_ARGS, savePath: p });
    await withServer(app, async (port) => {
      const { status } = await request(port, 'POST', '/api/send', {
        downloadId: e.id, recipientIds: ['r1'], book: { title: 'every summer after', author: 'Carley Fortune' },
      });
      assert.equal(status, 200);
    });
    const n = history.readAll().find((x) => x.type === 'notify');
    assert.equal(n.title, 'Every Summer After');
    assert.equal(notified.title, 'Every Summer After');
  } finally {
    recipients.byIds = orig.byIds; kindle.pushToKindle = orig.push; notify.notify = orig.notify;
    covers.resolveCover = orig.rc; covers.resolveMeta = orig.rm;
  }
});

test('search-result download button is marked done after success, original label restored on failure', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const fn = js.slice(js.indexOf('async function premiumDownload('), js.indexOf('// --- Download modal'));
  assert.match(fn, /ev\.step === 'done' && Array\.isArray\(ev\.downloads\) && ev\.downloads\.length\) downloaded = true/);
  assert.match(fn, /if \(btn && downloaded\) \{\s*btn\.textContent = 'Downloaded ✓';\s*btn\.classList\.add\('done'\);/);
  assert.match(fn, /btn\.disabled = false;\s*btn\.textContent = idleLabel;/);
  assert.doesNotMatch(fn, /btn\.textContent = 'Download \(Premium\)'/); // a set button keeps its own label
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  assert.match(css, /\.dl-btn\.done/);
});
