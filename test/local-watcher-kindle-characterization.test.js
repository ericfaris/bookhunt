'use strict';

// Characterization test (issue #47): pin TODAY's watcher Kindle push in local
// mode — it passes the download's savePath UNRESOLVED as filePath, with exactly
// { kindleEmail, filePath, filename }. Written and passing against the
// unmodified code; must stay green, unchanged. Stubbing mirrors
// test/watcher.test.js (the watcher calls its deps via the module objects).
const { test } = require('node:test');
const assert = require('node:assert');

const searcher = require('../src/searcher');
const watchlist = require('../src/watchlist');
const notify = require('../src/notify');
const recipients = require('../src/recipients');
const history = require('../src/history');
const downloader = require('../src/downloader');
const kindle = require('../src/kindle');
const booktags = require('../src/booktags');
const lists = require('../src/lists');
const listwatcher = require('../src/listwatcher');
const covers = require('../src/covers');
const watcher = require('../src/watcher');

test('local watcher autoDeliver: pushToKindle gets exactly { kindleEmail, filePath: savePath (unresolved), filename }', async () => {
  const targets = [
    [searcher, 'search', async () => ({ results: [{ title: 'Dune', author: 'Herbert', url: 'https://forum.mobilism.org/t1', premium: true }] })],
    [watchlist, 'update', () => {}],
    [watchlist, 'remove', () => true],
    [watchlist, 'readAll', () => []],
    [notify, 'notify', async () => [{ channel: 'email', ok: true }]],
    [recipients, 'byIds', () => [{ id: 'r1', name: 'Sam', email: 'sam@example.com', kindleEmail: 'sam@kindle.com' }]],
    [history, 'add', () => {}],
    [history, 'logDownload', () => ({ id: 'd1' })],
    [history, 'logNotify', () => ({ id: 'n1' })],
    [downloader, 'hasPremiumCreds', () => true],
    [downloader, 'premiumDownload', async () => ({
      downloads: [{ filename: 'Dune.epub', savePath: 'relative/dir/../Dune.epub', verified: true, size: 1234, titleMatch: true }],
      errors: [],
    })],
    [booktags, 'setTags', () => []],
    [lists, 'recordEvent', () => {}],
    [listwatcher, 'scheduleDigestSoon', () => {}],
    [covers, 'resolveCover', async () => null],
  ];
  const pushes = [];
  targets.push([kindle, 'pushToKindle', async (args) => { pushes.push(args); }]);
  const saved = targets.map(([obj, key]) => [obj, key, obj[key]]);
  for (const [obj, key, fn] of targets) obj[key] = fn;
  const prevAlert = process.env.WATCH_ALERT_EMAIL;
  process.env.WATCH_ALERT_EMAIL = 'op@example.com';
  try {
    const out = await watcher.checkWatch({ id: 'w1', title: 'Dune', author: 'Herbert', sort: 'newest', recipientIds: ['r1'], checkCount: 0 });
    assert.equal(out.delivery.kindlePushed, 1);
  } finally {
    for (const [obj, key, fn] of saved) obj[key] = fn;
    if (prevAlert === undefined) delete process.env.WATCH_ALERT_EMAIL;
    else process.env.WATCH_ALERT_EMAIL = prevAlert;
  }
  assert.equal(pushes.length, 1);
  assert.deepStrictEqual(pushes[0], { kindleEmail: 'sam@kindle.com', filePath: 'relative/dir/../Dune.epub', filename: 'Dune.epub' });
});
