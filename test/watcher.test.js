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
const lists = require('../src/lists');
const listwatcher = require('../src/listwatcher');
const covers = require('../src/covers');
const smtp = require('../src/smtp');
const watcher = require('../src/watcher');

async function withMocks(overrides, fn) {
  const orig = {
    search: searcher.search,
    update: watchlist.update,
    remove: watchlist.remove,
    readAll: watchlist.readAll,
    notify: notify.notify,
    byIds: recipients.byIds,
    add: history.add,
    logDownload: history.logDownload,
    logNotify: history.logNotify,
    hasCreds: downloader.hasPremiumCreds,
    premiumDownload: downloader.premiumDownload,
    push: kindle.pushToKindle,
    recordEvent: lists.recordEvent,
    scheduleDigestSoon: listwatcher.scheduleDigestSoon,
    resolveCover: covers.resolveCover,
    smtpConfigured: smtp.isConfigured,
    smtpTransport: smtp.getTransport,
  };
  // The outage alert sends mail through smtp directly — never let a test reach
  // a real SMTP server (.env may hold live creds). Streak state is per-test.
  const sentMail = overrides.sentMail || [];
  smtp.isConfigured = overrides.smtpConfigured || (() => true);
  smtp.getTransport = () => ({ sendMail: async (m) => { sentMail.push(m); } });
  watcher._resetOutageState();
  // Stubbed by default: autoDeliver resolves a catalog cover, and a test must
  // never reach the network for it.
  covers.resolveCover = overrides.resolveCover || (async () => null);
  searcher.search = overrides.search || (async () => ({ results: [] }));
  watchlist.update = overrides.update || (() => {});
  watchlist.remove = overrides.remove || (() => true);
  watchlist.readAll = overrides.readAll || (() => []);
  notify.notify = overrides.notify || (async () => [{ channel: 'email', ok: true }]);
  recipients.byIds = overrides.byIds || (() => []);
  history.add = overrides.add || (() => {});
  history.logDownload = overrides.logDownload || (() => ({ id: 'd1' }));
  history.logNotify = overrides.logNotify || (() => ({ id: 'n1' }));
  downloader.hasPremiumCreds = overrides.hasPremiumCreds || (() => false);
  downloader.premiumDownload = overrides.premiumDownload || (async () => ({ downloads: [], errors: [] }));
  kindle.pushToKindle = overrides.push || (async () => {});
  lists.recordEvent = overrides.recordEvent || (() => {});
  listwatcher.scheduleDigestSoon = overrides.scheduleDigestSoon || (() => {});
  try {
    return await fn();
  } finally {
    Object.assign(searcher, { search: orig.search });
    Object.assign(watchlist, { update: orig.update, remove: orig.remove, readAll: orig.readAll });
    Object.assign(notify, { notify: orig.notify });
    Object.assign(recipients, { byIds: orig.byIds });
    Object.assign(history, { add: orig.add, logDownload: orig.logDownload, logNotify: orig.logNotify });
    Object.assign(downloader, { hasPremiumCreds: orig.hasCreds, premiumDownload: orig.premiumDownload });
    Object.assign(kindle, { pushToKindle: orig.push });
    Object.assign(lists, { recordEvent: orig.recordEvent });
    Object.assign(listwatcher, { scheduleDigestSoon: orig.scheduleDigestSoon });
    Object.assign(covers, { resolveCover: orig.resolveCover });
    Object.assign(smtp, { isConfigured: orig.smtpConfigured, getTransport: orig.smtpTransport });
    watcher._resetOutageState();
  }
}

test('operatorEmail: honors WATCH_ALERT_EMAIL override', () => {
  const prev = process.env.WATCH_ALERT_EMAIL;
  process.env.WATCH_ALERT_EMAIL = 'me@example.com';
  assert.equal(watcher.operatorEmail(), 'me@example.com');
  if (prev === undefined) delete process.env.WATCH_ALERT_EMAIL;
  else process.env.WATCH_ALERT_EMAIL = prev;
});

test('checkWatch: a match with no download notifies (book.watch + link) and stays active to retry', async () => {
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
  // Found but not downloaded: NOT parked as fulfilled — stays active, backing off.
  assert.equal(updates.length, 1);
  const patch = updates[0];
  assert.ok(!('status' in patch), 'status stays active');
  assert.equal(patch.foundUrl, 'https://forum.mobilism.org/t1');
  assert.equal(patch.downloadMisses, 1);
  assert.equal(patch.downloaded, false);
  assert.ok(Date.parse(patch.retryAfter) > Date.now(), 'retryAfter is in the future');
  assert.match(patch.lastError, /^Found, not downloaded \(1\/\d+\): no premium credentials configured$/);
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
  const removedIds = [];
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
      remove: (id) => { removedIds.push(id); return true; },
    },
    async () => {
      const out = await watcher.checkWatch({ id: 'w4', title: 'Dune', author: 'Herbert', sort: 'newest', recipientIds: ['r1'], checkCount: 0 });
      assert.equal(out.matched, true);
      assert.equal(out.delivery.downloaded, true);
      assert.equal(out.delivery.kindlePushed, 1);
      assert.equal(out.delivery.verifiedMatch, true);
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
  // Strict verified match: watch removed outright, never marked fulfilled first.
  assert.deepEqual(removedIds, ['w4']);
  assert.equal(updatePatch, null);
});

test('checkWatch: a verified download with titleMatch=null delivers but stays fulfilled', async () => {
  process.env.WATCH_ALERT_EMAIL = 'op@example.com';
  const removedIds = [];
  let updatePatch = null;
  await withMocks(
    {
      search: async () => ({ results: [{ title: 'Dune', author: 'Herbert', url: 'https://forum.mobilism.org/t1', premium: true }] }),
      hasPremiumCreds: () => true,
      premiumDownload: async () => ({ downloads: [{ filename: 'X.epub', savePath: '/dl/X.epub', verified: true, titleMatch: null }], errors: [] }),
      remove: (id) => { removedIds.push(id); return true; },
      update: (_id, patch) => { updatePatch = patch; },
    },
    async () => {
      const out = await watcher.checkWatch({ id: 'w7', title: 'Dune', author: 'Herbert', sort: 'newest', recipientIds: [], checkCount: 0 });
      // Delivery bar unchanged — titleMatch null is still deliverable.
      assert.equal(out.delivery.downloaded, true);
      assert.equal(out.delivery.verifiedMatch, false);
    }
  );
  // Not verified-and-matched: the watch is NOT removed, it stays fulfilled.
  assert.equal(removedIds.length, 0, 'titleMatch null must not remove the watch');
  assert.ok(updatePatch, 'a fulfilled update was written');
  assert.equal(updatePatch.status, 'fulfilled');
  assert.equal(updatePatch.downloaded, true);
});

test('checkWatch: a wrong-book download (titleMatch=false) is NOT auto-sent', async () => {
  process.env.WATCH_ALERT_EMAIL = 'op@example.com';
  const pushes = [];
  const removedIds = [];
  await withMocks(
    {
      search: async () => ({ results: [{ title: 'Dune', url: 'https://forum.mobilism.org/t1', premium: true }] }),
      hasPremiumCreds: () => true,
      premiumDownload: async () => ({ downloads: [{ filename: 'Wrong.epub', savePath: '/dl/Wrong.epub', verified: true, titleMatch: false }], errors: [] }),
      byIds: () => [{ id: 'r1', name: 'Sam', email: 'sam@example.com', kindleEmail: 'sam@kindle.com' }],
      push: async (args) => { pushes.push(args); },
      remove: (id) => { removedIds.push(id); return true; },
    },
    async () => {
      const out = await watcher.checkWatch({ id: 'w5', title: 'Dune', sort: 'newest', recipientIds: ['r1'], checkCount: 0 });
      assert.equal(out.delivery.downloaded, false, 'mismatched book not treated as a download');
    }
  );
  assert.equal(pushes.length, 0, 'never auto-push a wrong book to Kindle');
  assert.equal(removedIds.length, 0, 'rejected wrong-book match must not remove the watch');
});

test('checkWatch: a radar (list-origin) strict match is removed AND still queues a digest event', async () => {
  process.env.WATCH_ALERT_EMAIL = 'op@example.com';
  const removedIds = [];
  const events = [];
  let scheduled = 0;
  const opEmails = [];
  await withMocks(
    {
      search: async () => ({ results: [{ title: 'Whistler', author: 'Grisham', url: 'https://forum.mobilism.org/t9', premium: true }] }),
      hasPremiumCreds: () => true,
      premiumDownload: async () => ({ downloads: [{ filename: 'Whistler.epub', savePath: '/dl/Whistler.epub', verified: true, titleMatch: true }], errors: [] }),
      remove: (id) => { removedIds.push(id); return true; },
      recordEvent: (e) => { events.push(e); },
      scheduleDigestSoon: () => { scheduled++; },
      notify: async (recipient) => { if (recipient.email === 'op@example.com') opEmails.push(recipient.email); return [{ channel: 'email', ok: true }]; },
    },
    async () => {
      await watcher.checkWatch({ id: 'w6', title: 'Whistler', author: 'Grisham', sort: 'newest', source: 'list', listLabel: 'NYT fiction', recipientIds: [], checkCount: 0 });
    }
  );
  // Removed even though it was a radar watch.
  assert.deepEqual(removedIds, ['w6']);
  // The digest event payload is complete despite the watch record being gone
  // (built from the in-memory watch/top — the decoupling being proven).
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    type: 'added',
    title: 'Whistler',
    author: 'Grisham',
    list: 'NYT fiction',
    url: 'https://forum.mobilism.org/t9',
  });
  assert.equal(scheduled, 1, 'digest was scheduled');
  // List-origin watches stay quiet for the operator (radar digest handles it).
  assert.equal(opEmails.length, 0, 'no per-book operator email for a list watch');
});

// --- Regression: a failed send must not be counted/recorded as delivered ----
// Bug: notify.notify() never throws (it swallows per-channel errors into its
// results array), but autoDeliver() was treating "the await didn't throw" as
// success and incrementing `delivered` unconditionally — so watchlist.json's
// `delivered` count (and the "sent to N" UI badge) claimed a send happened
// even when the SMTP send actually failed.
test('checkWatch: a failed email send is NOT counted as delivered', async () => {
  process.env.WATCH_ALERT_EMAIL = 'op@example.com';
  const notifyLogs = [];
  let updatePatch = null;
  await withMocks(
    {
      search: async () => ({ results: [{ title: 'Dune', author: 'Herbert', url: 'https://forum.mobilism.org/t1' }] }),
      byIds: () => [{ id: 'r1', name: 'Sam', email: 'sam@example.com' }],
      notify: async () => [{ channel: 'email', ok: false, error: 'SMTP auth failed' }],
      logNotify: (rec) => { notifyLogs.push(rec); return { id: 'n1' }; },
      update: (_id, patch) => { updatePatch = patch; },
    },
    async () => {
      const out = await watcher.checkWatch({ id: 'w30', title: 'Dune', author: 'Herbert', sort: 'newest', recipientIds: ['r1'], checkCount: 0 });
      assert.equal(out.delivery.delivered, 0, 'a failed send must not count as delivered');
    }
  );
  assert.ok(updatePatch, 'an update was written');
  assert.equal(updatePatch.delivered, 0, 'watchlist record must not claim a send that failed');
  // The failure is still logged to history (for audit), just marked not-ok.
  assert.equal(notifyLogs.length, 1);
  assert.equal(notifyLogs[0].channels[0].ok, false);
});

// --- The top search hit can be a dead-end "request" thread with no real -----
// download link (e.g. a Mobilism "Fulfilled eBook Request" post that only
// references Amazon) while a lower-ranked hit (a "Books by <author>"
// collection match) has the actual file. autoDeliver used to only ever try
// results[0], so this silently fell through to a notify-only email even
// though a real download existed one result down.
test('checkWatch: a dead-end top hit falls through to a real download further down the results', async () => {
  process.env.WATCH_ALERT_EMAIL = 'op@example.com';
  const removedIds = [];
  let logged = null;
  await withMocks(
    {
      search: async () => ({
        results: [
          { title: 'Request thread', url: 'https://forum.mobilism.org/dead-end', premium: true },
          { title: 'Books by Author', author: 'Herbert', url: 'https://forum.mobilism.org/real-post', premium: true },
        ],
      }),
      hasPremiumCreds: () => true,
      premiumDownload: async (url) => {
        if (url === 'https://forum.mobilism.org/dead-end') {
          throw new Error('No Premium icon found on this post — use the standard links');
        }
        return { downloads: [{ filename: 'Dune.epub', savePath: '/dl/Dune.epub', verified: true, titleMatch: true }], errors: [] };
      },
      logDownload: (rec) => { logged = rec; return { id: 'd10' }; },
      remove: (id) => { removedIds.push(id); return true; },
    },
    async () => {
      const out = await watcher.checkWatch({ id: 'w31', title: 'Dune', author: 'Herbert', sort: 'newest', recipientIds: [], checkCount: 0 });
      assert.equal(out.delivery.downloaded, true, 'a real download further down the results is not ignored');
      assert.equal(out.delivery.verifiedMatch, true);
    }
  );
  assert.deepEqual(removedIds, ['w31'], 'a verified match from a non-top candidate still removes the watch');
  assert.ok(logged);
  assert.equal(logged.url, 'https://forum.mobilism.org/real-post', 'logged against the post that actually yielded the file');
});

// --- Provenance: a book found inside a SET must not be labelled with the set --
// Regression: the radar watched "Saved By A God", matched the set post "Kings Of
// Mafia Series by Michelle Heard", pulled the right ePUB out of it — and then
// filed it in the Library under the SET's title, with the SET's cover art. The
// digest said one thing and the Library said another.
test('checkWatch: a set-post match is filed under the WATCHED book, not the set', async () => {
  process.env.WATCH_ALERT_EMAIL = 'op@example.com';
  let logged = null;
  let histAdd = null;
  const emails = [];
  const events = [];
  await withMocks(
    {
      search: async () => ({
        results: [{
          // What the searcher returns for a set post: the post names the SET, the
          // scraped image is the set's first book, and the searched book rides
          // along as matchedTitle/matchedAuthor.
          title: 'Kings Of Mafia Series',
          author: 'Michelle Heard',
          collection: true,
          setTitle: 'Kings Of Mafia Series',
          matchedTitle: 'Saved By A God',
          matchedAuthor: 'Michelle Heard',
          cover: null,
          url: 'https://forum.mobilism.org/t5414877',
          premium: true,
        }],
      }),
      hasPremiumCreds: () => true,
      // The downloader digs the right book out of the set — the FILE was always correct.
      premiumDownload: async () => ({
        downloads: [{ filename: 'Saved [Michelle Heard].epub', savePath: '/dl/Saved.epub', verified: true, titleMatch: null, size: 2471075 }],
        errors: [],
      }),
      resolveCover: async ({ title }) => (title === 'Saved By A God' ? 'https://covers/saved.jpg' : 'https://covers/WRONG-set.jpg'),
      logDownload: (rec) => { logged = rec; return { id: 'd1' }; },
      add: (rec) => { histAdd = rec; },
      notify: async (_r, book) => { emails.push(book); return [{ channel: 'email', ok: true }]; },
      recordEvent: (e) => { events.push(e); },
      update: () => {},
    },
    async () => {
      await watcher.checkWatch({
        id: 'w8', title: 'Saved By A God', author: 'Michelle Heard', sort: 'newest',
        source: 'list', listLabel: 'Amazon New Releases', recipientIds: [], checkCount: 0,
      });
    }
  );
  // The Library row — the thing that was wrong on screen.
  assert.equal(logged.title, 'Saved By A God', 'Library must show the watched book, not the set');
  assert.equal(logged.author, 'Michelle Heard');
  assert.equal(logged.filename, 'Saved [Michelle Heard].epub', 'the file itself was always right');
  // The cover was resolved for the BOOK, never the set's first-book art.
  assert.equal(logged.cover, 'https://covers/saved.jpg');
  // The history "watch-hit" row and the notification email agree with it.
  assert.equal(histAdd.title, 'Saved By A God');
  assert.ok(emails.every((b) => b.title === 'Saved By A God'), 'emails name the watched book');
  // And the digest still reports the same title the Library now shows.
  assert.equal(events[0].title, 'Saved By A God');
  assert.equal(events[0].type, 'added');
});

test('checkWatch: a plain (non-set) match still keeps the post title and scraped cover', async () => {
  process.env.WATCH_ALERT_EMAIL = 'op@example.com';
  let logged = null;
  await withMocks(
    {
      // A watch with no title (author-only) must still fall back to the post's title.
      search: async () => ({
        results: [{ title: 'A Voice in the Dark', author: 'Barbara Nickless', cover: 'http://x/voice.jpg', url: 'https://forum.mobilism.org/t2', premium: true }],
      }),
      hasPremiumCreds: () => true,
      premiumDownload: async () => ({
        downloads: [{ filename: 'Voice.epub', savePath: '/dl/Voice.epub', verified: true, titleMatch: true, size: 4300000 }],
        errors: [],
      }),
      resolveCover: async () => null, // catalog miss → fall back to the scraped cover
      logDownload: (rec) => { logged = rec; return { id: 'd2' }; },
      update: () => {},
      remove: () => true,
    },
    async () => {
      await watcher.checkWatch({ id: 'w9', title: '', author: 'Barbara Nickless', sort: 'newest', recipientIds: [], checkCount: 0 });
    }
  );
  assert.equal(logged.title, 'A Voice in the Dark', 'no watched title → the post title is right');
  assert.equal(logged.cover, 'http://x/voice.jpg', 'a non-set post image IS this book’s cover');
});

// --- Auto-expire after MAX_NO_MATCH_CHECKS consecutive no-match checks ------
test('checkWatch: a no-match check below the cap just records the check', async () => {
  const updates = [];
  const histAdds = [];
  await withMocks(
    {
      search: async () => ({ results: [] }),
      update: (id, patch) => updates.push(patch),
      add: (rec) => histAdds.push(rec),
    },
    async () => {
      const out = await watcher.checkWatch({ id: 'w10', title: 'Nope', author: '', sort: 'newest', checkCount: 18 });
      assert.equal(out.matched, false);
      assert.ok(!out.expired);
    }
  );
  assert.equal(updates.length, 1);
  assert.equal(updates[0].checkCount, 19);
  assert.ok(!('status' in updates[0]), 'not yet at the cap — status untouched');
  assert.equal(histAdds.length, 0, 'no history entry until it actually expires');
});

test('checkWatch: the Nth no-match check (default cap 20) marks the watch expired', async () => {
  const updates = [];
  const histAdds = [];
  await withMocks(
    {
      search: async () => ({ results: [] }),
      update: (id, patch) => updates.push(patch),
      add: (rec) => histAdds.push(rec),
    },
    async () => {
      const out = await watcher.checkWatch({ id: 'w11', title: 'Ghost', author: 'Nobody', sort: 'newest', checkCount: 19 });
      assert.equal(out.matched, false);
      assert.equal(out.expired, true);
    }
  );
  assert.equal(updates.length, 1);
  assert.equal(updates[0].checkCount, 20);
  assert.equal(updates[0].status, 'expired');
  assert.equal(histAdds.length, 1);
  assert.equal(histAdds[0].type, 'watch-hit');
  assert.equal(histAdds[0].status, 'expired');
  assert.equal(histAdds[0].title, 'Ghost');
});

test('checkWatch: never checked (checkCount undefined) does not immediately expire', async () => {
  const updates = [];
  await withMocks(
    { search: async () => ({ results: [] }), update: (id, patch) => updates.push(patch) },
    async () => {
      const out = await watcher.checkWatch({ id: 'w12', title: 'Fresh', author: '', sort: 'newest' });
      assert.equal(out.matched, false);
      assert.ok(!out.expired);
    }
  );
  assert.equal(updates[0].checkCount, 1);
  assert.ok(!('status' in updates[0]));
});

// --- checkNow (the "Check now" button) ---------------------------------------
// checkNow must refuse a non-active watch (a verified hit on a PAUSED watch
// would otherwise call watchlist.remove() out from under the user) and must
// share tick()'s concurrency guard so two overlapping calls can't both run.

test('checkNow: refuses a paused watch and does not touch it', async () => {
  let removed = 0;
  await withMocks(
    {
      readAll: () => [{ id: 'w20', title: 'Paused Book', author: '', sort: 'newest', status: 'paused' }],
      remove: (id) => { removed++; return true; },
      search: async () => ({ results: [{ title: 'Paused Book', url: 'https://forum.mobilism.org/t20' }] }),
    },
    async () => {
      await assert.rejects(() => watcher.checkNow('w20'), /resume/i);
    }
  );
  assert.equal(removed, 0, 'a paused watch must never be removed by "Check now"');
});

test('checkNow: refuses an expired watch too (only "active" may be checked)', async () => {
  await withMocks(
    { readAll: () => [{ id: 'w21', title: 'X', author: '', sort: 'newest', status: 'expired' }] },
    async () => {
      let err;
      try {
        await watcher.checkNow('w21');
      } catch (e) {
        err = e;
      }
      assert.ok(err, 'must throw');
      assert.ok(err.notActive, 'carries the notActive flag the route maps to a 409');
    }
  );
});

test('checkNow: an unknown id throws "Watch not found"', async () => {
  await withMocks({ readAll: () => [] }, async () => {
    await assert.rejects(() => watcher.checkNow('nope'), /not found/i);
  });
});

test('checkNow: runs an active watch and returns checkWatch\'s result', async () => {
  const updates = [];
  await withMocks(
    {
      readAll: () => [{ id: 'w22', title: 'Active Book', author: '', sort: 'newest', status: 'active', checkCount: 0 }],
      search: async () => ({ results: [] }),
      update: (id, patch) => updates.push(patch),
    },
    async () => {
      const out = await watcher.checkNow('w22');
      assert.equal(out.matched, false);
    }
  );
  assert.equal(updates.length, 1);
});

test('checkNow: a second concurrent call is rejected while one is in flight', async () => {
  let releaseSearch;
  const gate = new Promise((resolve) => { releaseSearch = resolve; });
  await withMocks(
    {
      readAll: () => [{ id: 'w23', title: 'Slow Book', author: '', sort: 'newest', status: 'active', checkCount: 0 }],
      search: async () => { await gate; return { results: [] }; },
      update: () => {},
    },
    async () => {
      const first = watcher.checkNow('w23');
      // Give the first call a tick to set the in-flight guard before the second fires.
      await new Promise((r) => setImmediate(r));
      await assert.rejects(() => watcher.checkNow('w23'), /already running/i);
      releaseSearch();
      await first;
    }
  );
});

// --- Found-but-not-downloaded retries (stranded 'fulfilled' watches) ---------
// Regression: any hit that failed to download — including a transient outage
// (2026-10-07: 9 hits, 0 downloads) — parked the watch in a terminal
// 'fulfilled' state that was never re-checked, stranding the book for good.

const DUNE_HIT = { results: [{ title: 'Dune', author: 'Herbert', url: 'https://forum.mobilism.org/t1', premium: true }] };

test('checkWatch: a failed download keeps the watch active, records the reason, and backs off', async () => {
  let patch = null;
  const removed = [];
  await withMocks(
    {
      search: async () => DUNE_HIT,
      hasPremiumCreds: () => true,
      premiumDownload: async () => { throw new Error('Mirror returned Not Found'); },
      update: (_id, p) => { patch = p; },
      remove: (id) => { removed.push(id); return true; },
    },
    async () => {
      const out = await watcher.checkWatch({ id: 'r1', title: 'Dune', author: 'Herbert', sort: 'newest', recipientIds: [], checkCount: 3 });
      assert.equal(out.matched, true);
      assert.equal(out.delivery.downloaded, false);
      assert.equal(out.delivery.failReason, 'Mirror returned Not Found');
    }
  );
  assert.deepEqual(removed, []);
  assert.ok(!('status' in patch), 'still active');
  assert.equal(patch.downloadMisses, 1);
  assert.equal(patch.checkCount, 4);
  assert.match(patch.lastError, /Mirror returned Not Found/);
  const wait = Date.parse(patch.retryAfter) - Date.now();
  assert.ok(wait > 23 * 3600e3 && wait <= 24 * 3600e3, 'first retry ~1 day out');
});

test('checkWatch: a repeat miss stays quiet — no second notify-only email, no second digest event', async () => {
  process.env.WATCH_ALERT_EMAIL = 'op@example.com';
  let notified = 0;
  const events = [];
  let patch = null;
  await withMocks(
    {
      search: async () => DUNE_HIT,
      byIds: () => [{ id: 'x', name: 'Sam', email: 'sam@example.com' }],
      notify: async () => { notified++; return [{ channel: 'email', ok: true }]; },
      recordEvent: (e) => events.push(e),
      update: (_id, p) => { patch = p; },
    },
    async () => {
      await watcher.checkWatch({ id: 'r2', title: 'Dune', sort: 'newest', recipientIds: ['x'], source: 'list', downloadMisses: 2, checkCount: 5 });
    }
  );
  assert.equal(notified, 0, 'recipients and operator not re-emailed on a retry miss');
  assert.equal(events.length, 0, 'digest already got the unverified event on the first miss');
  assert.equal(patch.downloadMisses, 3);
  const wait = Date.parse(patch.retryAfter) - Date.now();
  assert.ok(wait > 3.9 * 86400e3 && wait <= 4 * 86400e3, 'third miss backs off ~4 days');
});

test('checkWatch: the first miss of a list watch still queues an unverified digest event', async () => {
  const events = [];
  await withMocks(
    { search: async () => DUNE_HIT, recordEvent: (e) => events.push(e) },
    async () => {
      await watcher.checkWatch({ id: 'r3', title: 'Dune', sort: 'newest', recipientIds: [], source: 'list', checkCount: 0 });
    }
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'unverified');
});

test('checkWatch: a retry that finally downloads is delivered normally and removes the watch', async () => {
  process.env.WATCH_ALERT_EMAIL = 'op@example.com';
  const removed = [];
  const events = [];
  let notified = 0;
  await withMocks(
    {
      search: async () => DUNE_HIT,
      hasPremiumCreds: () => true,
      premiumDownload: async () => ({ downloads: [{ filename: 'Dune.epub', savePath: '/dl/Dune.epub', verified: true, titleMatch: true }], errors: [] }),
      remove: (id) => { removed.push(id); return true; },
      recordEvent: (e) => events.push(e),
      notify: async () => { notified++; return [{ channel: 'email', ok: true }]; },
    },
    async () => {
      await watcher.checkWatch({ id: 'r4', title: 'Dune', sort: 'newest', recipientIds: [], source: 'list', downloadMisses: 3, checkCount: 4 });
    }
  );
  assert.deepEqual(removed, ['r4']);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'added', 'a late success still reaches the digest');
});

test('checkWatch: the last allowed miss settles as fulfilled (notify-only) with the reason', async () => {
  let patch = null;
  await withMocks(
    { search: async () => DUNE_HIT, update: (_id, p) => { patch = p; } },
    async () => {
      await watcher.checkWatch({ id: 'r5', title: 'Dune', sort: 'newest', recipientIds: [], downloadMisses: watcher.MAX_DOWNLOAD_MISSES - 1, checkCount: 9 });
    }
  );
  assert.equal(patch.status, 'fulfilled');
  assert.equal(patch.downloaded, false);
  assert.equal(patch.downloadMisses, watcher.MAX_DOWNLOAD_MISSES);
  assert.equal(patch.retryAfter, null);
  assert.match(patch.lastError, /^Gave up after \d+ download attempts: no premium credentials configured$/);
});

test('checkWatch: a verified titleMatch=null download clears the error and stays fulfilled', async () => {
  let patch = null;
  await withMocks(
    {
      search: async () => DUNE_HIT,
      hasPremiumCreds: () => true,
      premiumDownload: async () => ({ downloads: [{ filename: 'X.epub', savePath: '/dl/X.epub', verified: true, titleMatch: null }], errors: [] }),
      update: (_id, p) => { patch = p; },
    },
    async () => {
      await watcher.checkWatch({ id: 'r6', title: 'Dune', sort: 'newest', recipientIds: [], downloadMisses: 2, checkCount: 1 });
    }
  );
  assert.equal(patch.status, 'fulfilled');
  assert.equal(patch.downloaded, true);
  assert.equal(patch.lastError, null);
});

test('checkWatch: a wrong-book download records the mismatch as the reason', async () => {
  let patch = null;
  await withMocks(
    {
      search: async () => DUNE_HIT,
      hasPremiumCreds: () => true,
      premiumDownload: async () => ({ downloads: [{ filename: 'W.epub', savePath: '/dl/W.epub', verified: true, titleMatch: false }], errors: [] }),
      update: (_id, p) => { patch = p; },
    },
    async () => {
      await watcher.checkWatch({ id: 'r7', title: 'Dune', sort: 'newest', recipientIds: [], checkCount: 0 });
    }
  );
  assert.match(patch.lastError, /different book/);
});

test('checkWatch: no verified ePUB summarizes per-candidate errors as the reason', async () => {
  let patch = null;
  const histories = [];
  await withMocks(
    {
      search: async () => DUNE_HIT,
      hasPremiumCreds: () => true,
      premiumDownload: async () => ({ downloads: [], errors: [{ url: 'u', error: 'filedot: link expired' }] }),
      update: (_id, p) => { patch = p; },
      add: (h) => histories.push(h),
    },
    async () => {
      await watcher.checkWatch({ id: 'r8', title: 'Dune', sort: 'newest', recipientIds: [], checkCount: 0 });
    }
  );
  assert.match(patch.lastError, /filedot: link expired/);
  assert.equal(histories[0].status, 'retrying');
  assert.equal(histories[0].reason, 'filedot: link expired');
});

test('summarizeDownloadErrors: dedupes, caps at two messages, and has a no-error fallback', () => {
  const s = watcher.summarizeDownloadErrors;
  assert.equal(s([], 3), 'no verified ePUB in 3 results');
  assert.equal(s(undefined, 1), 'no verified ePUB in 1 result');
  assert.equal(s([{ error: 'a' }, { error: 'a' }, { error: 'b' }], 2), 'a; b');
  assert.equal(s([{ error: 'a' }, { error: 'b' }, { error: 'c' }, { error: 'd' }], 4), 'a; b (+2 more)');
  assert.ok(s([{ error: 'x'.repeat(500) }], 1).length <= 240);
});

test('missBackoffMs: 1d, 2d, 4d, then capped at 7d', () => {
  const day = 86400e3;
  assert.equal(watcher.missBackoffMs(1), day);
  assert.equal(watcher.missBackoffMs(2), 2 * day);
  assert.equal(watcher.missBackoffMs(3), 4 * day);
  assert.equal(watcher.missBackoffMs(4), 7 * day);
  assert.equal(watcher.missBackoffMs(10), 7 * day);
});

// --- Outage alert: a run of hits with no download emails the operator once ----

test('noteDeliveryOutcome: alerts once after N consecutive misses, resets on a download', async () => {
  process.env.WATCH_ALERT_EMAIL = 'op@example.com';
  const sentMail = [];
  await withMocks({ sentMail }, async () => {
    const N = watcher.OUTAGE_THRESHOLD;
    for (let i = 0; i < N - 1; i++) watcher.noteDeliveryOutcome(false, { title: `B${i}`, reason: 'session expired' });
    await new Promise((r) => setImmediate(r));
    assert.equal(sentMail.length, 0, 'no alert below the threshold');
    watcher.noteDeliveryOutcome(false, { title: 'Last', reason: 'session expired' });
    await new Promise((r) => setImmediate(r));
    assert.equal(sentMail.length, 1, 'alert at the threshold');
    assert.equal(sentMail[0].to, 'op@example.com');
    assert.match(sentMail[0].text, /Last: session expired/);
    watcher.noteDeliveryOutcome(false, { title: 'More', reason: 'x' });
    await new Promise((r) => setImmediate(r));
    assert.equal(sentMail.length, 1, 'only one alert per outage');
    // A download ends the outage; a fresh run alerts again.
    watcher.noteDeliveryOutcome(true, {});
    for (let i = 0; i < N - 1; i++) watcher.noteDeliveryOutcome(false, { title: `C${i}`, reason: 'y' });
    await new Promise((r) => setImmediate(r));
    assert.equal(sentMail.length, 1, 'streak restarted from zero after a download');
    watcher.noteDeliveryOutcome(false, { title: 'C-last', reason: 'y' });
    await new Promise((r) => setImmediate(r));
    assert.equal(sentMail.length, 2);
  });
});

test('noteDeliveryOutcome: a download in between breaks the streak (no alert)', async () => {
  const sentMail = [];
  await withMocks({ sentMail }, async () => {
    for (let i = 0; i < watcher.OUTAGE_THRESHOLD * 2; i++) watcher.noteDeliveryOutcome(i % 2 === 0, { title: 't', reason: 'r' });
    await new Promise((r) => setImmediate(r));
  });
  assert.equal(sentMail.length, 0);
});

test('noteDeliveryOutcome: no SMTP configured → no send attempt, no throw', async () => {
  const sentMail = [];
  await withMocks({ sentMail, smtpConfigured: () => false }, async () => {
    for (let i = 0; i < watcher.OUTAGE_THRESHOLD; i++) watcher.noteDeliveryOutcome(false, { title: 't', reason: 'r' });
    await new Promise((r) => setImmediate(r));
  });
  assert.equal(sentMail.length, 0);
});

test('checkWatch: consecutive failed hits feed the outage alert', async () => {
  process.env.WATCH_ALERT_EMAIL = 'op@example.com';
  const sentMail = [];
  await withMocks({ sentMail, search: async () => DUNE_HIT }, async () => {
    for (let i = 0; i < watcher.OUTAGE_THRESHOLD; i++) {
      await watcher.checkWatch({ id: `o${i}`, title: `Book ${i}`, sort: 'newest', recipientIds: [], source: 'list', checkCount: 0 });
    }
    await new Promise((r) => setImmediate(r));
  });
  assert.equal(sentMail.length, 1);
  assert.match(sentMail[0].text, /Book 4: no premium credentials configured/);
});
