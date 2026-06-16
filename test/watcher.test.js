'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// Monkeypatch the singletons the watcher depends on (it calls them via the
// required module objects, so replacing methods here is observed at call time).
const searcher = require('../src/searcher');
const watchlist = require('../src/watchlist');
const notify = require('../src/notify');
const recipients = require('../src/recipients');
const history = require('../src/history');
const downloader = require('../src/downloader');
const kindle = require('../src/kindle');
const watcher = require('../src/watcher');

async function withMocks(overrides, fn) {
  const orig = {
    search: searcher.search,
    update: watchlist.update,
    notify: notify.notify,
    byIds: recipients.byIds,
    add: history.add,
    logDownload: history.logDownload,
    hasCreds: downloader.hasPremiumCreds,
    premiumDownload: downloader.premiumDownload,
    push: kindle.pushToKindle,
  };
  searcher.search = overrides.search || (async () => ({ results: [] }));
  watchlist.update = overrides.update || (() => {});
  notify.notify = overrides.notify || (async () => [{ channel: 'email', ok: true }]);
  recipients.byIds = overrides.byIds || (() => []);
  history.add = overrides.add || (() => {});
  history.logDownload = overrides.logDownload || (() => ({ id: 'd1' }));
  downloader.hasPremiumCreds = overrides.hasPremiumCreds || (() => false);
  downloader.premiumDownload = overrides.premiumDownload || (async () => ({ downloads: [], errors: [] }));
  kindle.pushToKindle = overrides.push || (async () => {});
  try {
    return await fn();
  } finally {
    Object.assign(searcher, { search: orig.search });
    Object.assign(watchlist, { update: orig.update });
    Object.assign(notify, { notify: orig.notify });
    Object.assign(recipients, { byIds: orig.byIds });
    Object.assign(history, { add: orig.add, logDownload: orig.logDownload });
    Object.assign(downloader, { hasPremiumCreds: orig.hasCreds, premiumDownload: orig.premiumDownload });
    Object.assign(kindle, { pushToKindle: orig.push });
  }
}

test('operatorEmail: honors WATCH_ALERT_EMAIL override', () => {
  const prev = process.env.WATCH_ALERT_EMAIL;
  process.env.WATCH_ALERT_EMAIL = 'me@example.com';
  assert.equal(watcher.operatorEmail(), 'me@example.com');
  if (prev === undefined) delete process.env.WATCH_ALERT_EMAIL;
  else process.env.WATCH_ALERT_EMAIL = prev;
});

test('checkWatch: a match notifies (book.watch + link) and marks fulfilled', async () => {
  process.env.WATCH_ALERT_EMAIL = 'op@example.com';
  const updates = [];
  const notifies = [];
  await withMocks(
    {
      search: async () => ({
        results: [{ title: 'Dune', author: 'Frank Herbert', cover: 'http://x/c.jpg', description: 'epic', url: 'https://forum.mobilism.org/t1' }],
      }),
      update: (id, patch) => updates.push(patch),
      notify: async (recipient, book) => { notifies.push({ recipient, book }); return [{ channel: 'email', ok: true }]; },
    },
    async () => {
      const out = await watcher.checkWatch({ id: 'w1', title: 'Dune', author: 'Frank Herbert', sort: 'newest', recipientIds: [], checkCount: 0 });
      assert.equal(out.matched, true);
    }
  );
  // Notified the operator with a watch-flavored book carrying the thread link.
  assert.ok(notifies.length >= 1);
  assert.equal(notifies[0].book.watch, true);
  assert.equal(notifies[0].book.link, 'https://forum.mobilism.org/t1');
  assert.equal(notifies[0].recipient.email, 'op@example.com');
  // Marked fulfilled with the found URL.
  const fulfilled = updates.find((p) => p.status === 'fulfilled');
  assert.ok(fulfilled, 'an update set status fulfilled');
  assert.equal(fulfilled.foundUrl, 'https://forum.mobilism.org/t1');
});

test('checkWatch: no match records the check and does NOT notify or fulfill', async () => {
  const updates = [];
  let notified = 0;
  await withMocks(
    {
      search: async () => ({ results: [] }),
      update: (id, patch) => updates.push(patch),
      notify: async () => { notified++; return []; },
    },
    async () => {
      const out = await watcher.checkWatch({ id: 'w2', title: 'Nope', author: '', sort: 'newest', checkCount: 2 });
      assert.equal(out.matched, false);
    }
  );
  assert.equal(notified, 0);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].checkCount, 3); // incremented
  assert.ok(!('status' in updates[0]), 'status untouched on no match');
  assert.ok(updates[0].lastCheckedAt, 'records lastCheckedAt');
});

test('checkWatch: also notifies selected recipients', async () => {
  process.env.WATCH_ALERT_EMAIL = 'op@example.com';
  const recipientsSeen = [];
  await withMocks(
    {
      search: async () => ({ results: [{ title: 'T', url: 'https://forum.mobilism.org/t2' }] }),
      update: () => {},
      byIds: () => [{ id: 'r1', name: 'Sam', email: 'sam@example.com' }],
      notify: async (recipient) => { recipientsSeen.push(recipient.email); return [{ channel: 'email', ok: true }]; },
    },
    async () => {
      await watcher.checkWatch({ id: 'w3', title: 'T', author: '', sort: 'newest', recipientIds: ['r1'], checkCount: 0 });
    }
  );
  assert.ok(recipientsSeen.includes('op@example.com'), 'operator notified');
  assert.ok(recipientsSeen.includes('sam@example.com'), 'selected recipient notified');
});

// --- Autonomous download + Kindle + notify on a premium match ----------------
test('checkWatch: a premium match auto-downloads, pushes to Kindle, and notifies', async () => {
  process.env.WATCH_ALERT_EMAIL = 'op@example.com';
  const pushes = [];
  const emails = [];
  let logged = null;
  let updatePatch = null;
  await withMocks(
    {
      search: async () => ({ results: [{ title: 'Dune', author: 'Herbert', url: 'https://forum.mobilism.org/t1', premium: true, cover: 'http://x/c.jpg' }] }),
      hasPremiumCreds: () => true,
      premiumDownload: async () => ({ downloads: [{ filename: 'Dune.epub', savePath: '/dl/Dune.epub', verified: true, size: 1234, titleMatch: true }], errors: [] }),
      logDownload: (rec) => { logged = rec; return { id: 'd9' }; },
      byIds: () => [{ id: 'r1', name: 'Sam', email: 'sam@example.com', kindleEmail: 'sam@kindle.com' }],
      push: async (args) => { pushes.push(args); },
      notify: async (recipient, book) => { emails.push({ to: recipient.email, pushed: book.pushedToKindle }); return [{ channel: 'email', ok: true }]; },
      update: (_id, patch) => { updatePatch = patch; },
    },
    async () => {
      const out = await watcher.checkWatch({ id: 'w4', title: 'Dune', author: 'Herbert', sort: 'newest', recipientIds: ['r1'], checkCount: 0 });
      assert.equal(out.matched, true);
      assert.equal(out.delivery.downloaded, true);
      assert.equal(out.delivery.kindlePushed, 1);
    }
  );
  // Pushed the downloaded file to the recipient's Kindle.
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].kindleEmail, 'sam@kindle.com');
  assert.equal(pushes[0].filePath, '/dl/Dune.epub');
  // Logged a real premium download (so it lands in the Library) and emailed Sam
  // (pushed=true) + the operator.
  assert.ok(logged && logged.mode === 'premium' && logged.verified === true);
  assert.ok(emails.some((e) => e.to === 'sam@example.com' && e.pushed === true));
  assert.ok(emails.some((e) => e.to === 'op@example.com'));
  assert.equal(updatePatch.downloaded, true);
});

test('checkWatch: a wrong-book download (titleMatch=false) is NOT auto-sent', async () => {
  process.env.WATCH_ALERT_EMAIL = 'op@example.com';
  const pushes = [];
  await withMocks(
    {
      search: async () => ({ results: [{ title: 'Dune', url: 'https://forum.mobilism.org/t1', premium: true }] }),
      hasPremiumCreds: () => true,
      premiumDownload: async () => ({ downloads: [{ filename: 'Wrong.epub', savePath: '/dl/Wrong.epub', verified: true, titleMatch: false }], errors: [] }),
      byIds: () => [{ id: 'r1', name: 'Sam', email: 'sam@example.com', kindleEmail: 'sam@kindle.com' }],
      push: async (args) => { pushes.push(args); },
    },
    async () => {
      const out = await watcher.checkWatch({ id: 'w5', title: 'Dune', sort: 'newest', recipientIds: ['r1'], checkCount: 0 });
      assert.equal(out.delivery.downloaded, false, 'mismatched book not treated as a download');
    }
  );
  assert.equal(pushes.length, 0, 'never auto-push a wrong book to Kindle');
});
