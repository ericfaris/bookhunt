'use strict';

// Background scheduler for the watchlist (issue #7). Periodically re-runs each
// active watch through the SAME search pipeline as interactive search, and on the
// first match notifies the user (email, with cover + thread link). A match whose
// acquisition is verified AND positively title-matched removes the watch outright;
// a download with titleMatch null marks it fulfilled; a match that yields no
// download stays active and retries on a backoff (MAX_DOWNLOAD_MISSES) before
// settling as fulfilled (notify-only).
//
// Politeness & safety:
//  - Re-checks each watch at most every WATCH_CHECK_INTERVAL_MS (default 30 min).
//  - Runs at most ONE due watch per tick so we never burst the forum.
//  - Only runs when the Mobilism session is ready (autowarm keeps it warm);
//    otherwise it skips and tries again next tick.
//  - searcher.search() is queued behind the shared browser, so a watch check
//    never collides with an interactive search/download.

const searcher = require('./searcher');
const watchlist = require('./watchlist');
const notify = require('./notify');
const recipients = require('./recipients');
const history = require('./history');
const settings = require('./settings');
const downloader = require('./downloader');
const kindle = require('./kindle');
const booktags = require('./booktags');
const lists = require('./lists');
const covers = require('./covers');
const storage = require('./storage');
const smtp = require('./smtp');

const TICK_MS = Number(process.env.WATCH_TICK_MS) || 300000; // wake every 5 min
// A watch that has gone this many no-match checks without a hit is retired —
// marked expired (not deleted) so it stays visible and can be re-activated via
// the same status toggle used elsewhere, mirroring how list-origin watches
// already expire on age (lists.js) rather than vanish silently.
const MAX_NO_MATCH_CHECKS = Number(process.env.WATCH_MAX_CHECKS) || 20;
// List-origin watches never re-check faster than this, whatever the user's
// watchlist cadence — bestseller lists refresh weekly, and dozens of radar
// watches on a tight cadence would be impolite to the forum.
const LIST_RECHECK_FLOOR_MS = Number(process.env.LIST_RECHECK_FLOOR_MS) || 24 * 3600 * 1000;
// A hit that doesn't yield a download (wrong thread, dead mirror, a transient
// host/session outage) keeps the watch ACTIVE and retries on a backoff —
// 1d, 2d, 4d, then weekly — instead of parking it in a terminal 'fulfilled'
// state forever. After this many failed attempts it settles as fulfilled
// (notify-only), as before.
const MAX_DOWNLOAD_MISSES = Number(process.env.WATCH_MAX_DOWNLOAD_MISSES) || 6;
const MISS_BACKOFF_BASE_MS = Number(process.env.WATCH_MISS_BACKOFF_MS) || 24 * 3600 * 1000;
const MISS_BACKOFF_MAX_MS = 7 * 24 * 3600 * 1000;
// This many hits in a row with no download (across all watches) looks like a
// broken download path rather than bad luck — email the operator once.
const OUTAGE_THRESHOLD = Number(process.env.WATCH_OUTAGE_THRESHOLD) || 5;
// The per-watch re-check cadence is user-configurable in Settings (settings.js);
// read it fresh each tick so changes take effect without a restart.

// Who to notify by default — the operator who set the watch. Mirrors
// autowarm's alertEmail(): explicit override, else first CF-Access email, else
// the SMTP identity.
function operatorEmail() {
  const allowed = (process.env.CF_ACCESS_ALLOWED_EMAILS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    process.env.WATCH_ALERT_EMAIL ||
    process.env.WARM_ALERT_EMAIL ||
    allowed[0] ||
    process.env.SMTP_FROM ||
    process.env.SMTP_USER ||
    ''
  );
}

// The watch's delivery audience: the recipients explicitly related to it. With
// none related, we deliver to nobody automatically (the operator is always
// emailed separately) — auto-pushing a book to every saved reader would be
// surprising, so recipients must be opted in per watch.
function deliveryRecipients(watch) {
  return watch.recipientIds && watch.recipientIds.length ? recipients.byIds(watch.recipientIds) : [];
}

/**
 * Autonomously deliver a matched book (issue #7 follow-up): when credentials
 * are set, walk every search hit (not just the top-ranked one — see
 * downloader.runCandidates) trying a verified premium download, push it to
 * each recipient's Kindle, and email everyone. If no candidate yields a
 * download (no creds / none premium / unverified / wrong-book), gracefully
 * fall back to a notify-only email with the top hit's thread link so nothing
 * is ever silently dropped. Always emails the operator. Never throws.
 *
 * `results` is the full ranked array from searcher.search() for this watch;
 * results[0] supplies the book's title/author/cover/link when nothing downloads.
 *
 * Returns { downloaded, delivered, kindlePushed, verifiedMatch }. `verifiedMatch`
 * is true only when the accepted download passed the strict bar — verified AND
 * positively title-matched — which is the watch-removal criterion (stricter than
 * the delivery bar, which also accepts titleMatch === null).
 */
async function autoDeliver(watch, results, opts = {}) {
  // Record the book we WATCHED FOR, not the forum post's title. A set post
  // ("Kings Of Mafia Series by Michelle Heard") legitimately CONTAINS the book —
  // the downloader digs the right ePUB out of it — but its title names the set
  // and its scraped image is the set's first book. Preferring top.title here is
  // what put "Kings Of Mafia Series" in the Library when the radar had acquired
  // "Saved By A God". The interactive path (server.js) already prefers the
  // searched title; this mirrors it.
  const top = results[0];
  const book = {
    title: watch.title || top.matchedTitle || top.title,
    author: watch.author || top.author,
    cover: null,
    description: top.description || '',
    link: top.url || null,
    watch: true,
  };
  // Same reasoning for the cover: prefer a title+author-verified catalog cover,
  // and fall back to the scraped post image only for a non-set post, where it is
  // actually this book's cover.
  try {
    book.cover = await covers.resolveCover({ title: book.title, author: book.author });
  } catch { /* fall through */ }
  if (!book.cover && !top.collection) book.cover = top.cover || null;
  const targets = deliveryRecipients(watch);

  // 1) Try an autonomous, verified premium download — walk EVERY search hit,
  // not just the top-ranked one (mirrors the interactive /api/download batch
  // path's downloader.runCandidates). A title-exact "request/bounty" thread
  // often ranks first but carries no real download link (just a reference
  // link, e.g. Amazon) — the actual file can live in a lower-ranked post
  // (a "Books by <author>" collection match). Trying only results[0] meant
  // that dead end silently fell through to a notify-only email even when a
  // real download existed one result down.
  let download = null;
  // Why no download was accepted — persisted on the watch (lastError) so a
  // failed acquisition is diagnosable without the container's logs.
  let failReason = null;
  if (!downloader.hasPremiumCreds()) {
    failReason = 'no premium credentials configured';
  } else {
    const candidates = results.filter((r) => r.url);
    if (!candidates.length) failReason = 'no result had a thread link';
    if (candidates.length) {
      // runCandidates tries candidates in order and stops at the first one
      // that verifies (rank >= 3 — see downloadRank), so whenever `download`
      // ends up accepted below, `attemptedUrl` is guaranteed to be the URL of
      // the candidate that actually produced it — not necessarily `top.url`.
      let attemptedUrl = top.url;
      try {
        const { result, errors } = await downloader.runCandidates(
          candidates,
          (cand) => {
            attemptedUrl = cand.url;
            return downloader.premiumDownload(cand.url, () => {}, watch.title || cand.title);
          },
          () => {}
        );
        download = ((result && result.downloads) || []).find((d) => d.verified) || null;
        // Safety: never auto-send a book whose embedded title clearly mismatches.
        if (download && download.titleMatch === false) {
          console.warn('[watcher] downloaded "%s" but embedded title mismatched — not auto-sending', book.title);
          failReason = 'downloaded ePUB is a different book (embedded title mismatch)';
          download = null;
        } else if (download) {
          download.url = download.url || attemptedUrl;
        } else {
          failReason = summarizeDownloadErrors(errors, candidates.length);
        }
      } catch (err) {
        failReason = (err && err.message) || 'download failed';
        console.warn('[watcher] auto-download failed for "%s": %s', book.title, failReason);
      }
    }
  }

  // 2) Log a real download to history/Library so it behaves like a manual one.
  let downloadId = null;
  if (download) {
    try {
      const rec = history.logDownload({
        title: book.title, author: book.author, cover: book.cover,
        filename: download.filename, savePath: download.savePath, url: download.url || top.url,
        mode: 'premium', verified: download.verified, size: download.size,
      });
      downloadId = rec && rec.id;
    } catch { /* best effort */ }
    // List-origin watches carry tags so the Library groups auto-acquisitions.
    if (Array.isArray(watch.tags) && watch.tags.length && download.savePath) {
      try { booktags.setTags(download.savePath, watch.tags); } catch { /* best effort */ }
    }
  }

  if (!download && failReason) {
    console.warn('[watcher] no download for "%s": %s', book.title, failReason);
  }
  // A retry of a watch whose earlier hit already sent the notify-only email
  // stays quiet when it fails again — one "found it, here's the link" per book,
  // not one per daily retry.
  const quiet = !download && opts.quiet === true;

  // 3) Deliver to recipients: push the file to Kindle (when we have it + an
  // address), then email them. Dedup emails so the operator isn't doubled up.
  let delivered = 0;
  let kindlePushed = 0;
  const emailed = new Set();
  // Fetched at most once for all recipients (#47): local passes the savePath
  // as-is (unresolved, as before); r2 pulls the bytes from the bucket.
  let att = null;
  let attErr = null;
  for (const r of targets) {
    let pushed = false;
    if (download && r.kindleEmail) {
      try {
        if (!att && !attErr) {
          const store = storage.get();
          try {
            att = store.mode === 'local' ? { filePath: download.savePath } : await store.attachment(download.savePath);
          } catch (e) {
            attErr = e;
          }
        }
        if (attErr) throw attErr;
        await kindle.pushToKindle({ kindleEmail: r.kindleEmail, filename: download.filename, ...att });
        pushed = true;
        kindlePushed++;
      } catch (err) {
        console.warn('[watcher] Kindle push failed for %s: %s', r.kindleEmail, err.message);
      }
    }
    if (r.email && !quiet) {
      const channelResults = await notify.notify(r, { ...book, pushedToKindle: pushed }, ['email']);
      const emailResult = channelResults.find((c) => c.channel === 'email');
      if (emailResult && emailResult.ok) {
        emailed.add(String(r.email).toLowerCase());
        delivered++;
      } else {
        console.warn('[watcher] notify failed for %s: %s', r.email, (emailResult && emailResult.error) || 'unknown error');
      }
      try {
        history.logNotify({
          downloadId,
          title: book.title,
          filename: download && download.filename,
          to: [r.name],
          kindlePushed: pushed,
          channels: channelResults,
        });
      } catch { /* best effort */ }
    }
  }

  // 4) Always tell the operator (unless they were already emailed as a
  // recipient). List-origin watches stay quiet here — their outcome lands in
  // the radar's digest email instead of one email per book.
  const op = watch.source === 'list' || quiet ? '' : operatorEmail();
  if (op && !emailed.has(op.toLowerCase())) {
    const opResults = await notify.notify({ email: op, name: '' }, { ...book, pushedToKindle: false }, ['email']);
    const opEmail = opResults.find((c) => c.channel === 'email');
    if (!opEmail || !opEmail.ok) {
      console.warn('[watcher] operator notify failed: %s', (opEmail && opEmail.error) || 'unknown error');
    }
  }

  return {
    downloaded: !!download,
    delivered,
    kindlePushed,
    verifiedMatch: !!(download && download.verified === true && download.titleMatch === true),
    failReason: download ? null : failReason,
  };
}

/** PURE: one short line out of runCandidates' per-candidate errors. */
function summarizeDownloadErrors(errors, candidateCount) {
  const msgs = [...new Set((errors || []).map((e) => e && e.error).filter(Boolean))];
  if (!msgs.length) return `no verified ePUB in ${candidateCount} result${candidateCount === 1 ? '' : 's'}`;
  const head = msgs.slice(0, 2).join('; ');
  const line = msgs.length > 2 ? `${head} (+${msgs.length - 2} more)` : head;
  return line.length > 240 ? line.slice(0, 237) + '…' : line;
}

/**
 * Run one watch through the search pipeline. On a match: notify, then either
 * remove the watch (verified + positively title-matched acquisition) or mark it
 * fulfilled (any weaker match). Always records lastCheckedAt/checkCount on a
 * no-match. Returns { matched, notifyResults? }.
 * Throws only on a hard search failure (caller records lastError).
 */
async function checkWatch(watch) {
  const { results } = await searcher.search({
    title: watch.title,
    author: watch.author,
    sort: watch.sort,
  });

  const base = { lastCheckedAt: new Date().toISOString(), checkCount: (watch.checkCount || 0) + 1, lastError: null };

  if (results && results.length) {
    const top = results[0];
    const priorMisses = watch.downloadMisses || 0;
    let delivery = { downloaded: false, delivered: 0, kindlePushed: 0, verifiedMatch: false, failReason: null };
    try {
      delivery = await autoDeliver(watch, results, { quiet: priorMisses > 0 });
    } catch (err) {
      delivery.failReason = err.message;
      console.warn('[watcher] delivery failed for %s: %s', watch.id, err.message);
    }
    const now = Date.now();
    const misses = delivery.downloaded ? priorMisses : priorMisses + 1;
    const retrying = !delivery.downloaded && misses < MAX_DOWNLOAD_MISSES;
    const reason = delivery.failReason || 'no download';
    if (delivery.verifiedMatch) {
      // Verified, positively title-matched acquisition: the watch has done its job —
      // delete it outright rather than leaving a fulfilled row behind.
      watchlist.remove(watch.id);
    } else if (retrying) {
      watchlist.update(watch.id, {
        ...base,
        foundUrl: top.url || null,
        foundAt: new Date(now).toISOString(),
        delivered: delivery.delivered,
        kindlePushed: delivery.kindlePushed,
        downloaded: false,
        downloadMisses: misses,
        retryAfter: new Date(now + missBackoffMs(misses)).toISOString(),
        lastError: `Found, not downloaded (${misses}/${MAX_DOWNLOAD_MISSES}): ${reason}`,
      });
    } else {
      watchlist.update(watch.id, {
        ...base,
        status: 'fulfilled',
        foundUrl: top.url || null,
        foundAt: new Date(now).toISOString(),
        delivered: delivery.delivered,
        kindlePushed: delivery.kindlePushed,
        downloaded: delivery.downloaded,
        downloadMisses: misses,
        retryAfter: null,
        lastError: delivery.downloaded ? null : `Gave up after ${misses} download attempts: ${reason}`,
      });
    }
    noteDeliveryOutcome(delivery.downloaded, { title: watch.title || top.title, reason });
    try {
      history.add({
        type: 'watch-hit',
        title: watch.title || top.matchedTitle || top.title,
        author: watch.author || top.author,
        url: top.url || null,
        status: retrying ? 'retrying' : 'fulfilled',
        ...(delivery.downloaded ? {} : { reason }),
      });
    } catch { /* best effort */ }
    // Feed the radar's digest: verified acquisition vs. found-but-unverified.
    // A retry that fails again was already reported on its first miss.
    if (watch.source === 'list' && (delivery.downloaded || priorMisses === 0)) {
      try {
        lists.recordEvent({
          type: delivery.downloaded ? 'added' : 'unverified',
          title: watch.title || top.title,
          author: watch.author || top.author,
          list: watch.listLabel || '',
          url: top.url || null,
        });
        require('./listwatcher').scheduleDigestSoon(); // lazy — avoids require cycle
      } catch { /* best effort */ }
    }
    console.log(
      '[watcher] match for "%s" — %s, emailed %d, kindle %d%s',
      watch.title || watch.author,
      delivery.downloaded ? 'downloaded' : 'notify-only',
      delivery.delivered,
      delivery.kindlePushed,
      delivery.verifiedMatch ? ', watch removed' : retrying ? `, retrying (${misses}/${MAX_DOWNLOAD_MISSES})` : ', watch fulfilled'
    );
    return { matched: true, delivery };
  }

  if (base.checkCount >= MAX_NO_MATCH_CHECKS) {
    watchlist.update(watch.id, { ...base, status: 'expired' });
    console.log('[watcher] "%s" hit %d checks with no match — expiring', watch.title || watch.author, base.checkCount);
    try {
      history.add({
        type: 'watch-hit',
        title: watch.title || watch.author,
        author: watch.author,
        url: null,
        status: 'expired',
      });
    } catch { /* best effort */ }
    return { matched: false, expired: true };
  }

  watchlist.update(watch.id, base);
  return { matched: false };
}

/** PURE: wait before re-trying a hit that didn't download (misses >= 1). */
function missBackoffMs(misses) {
  return Math.min(MISS_BACKOFF_BASE_MS * 2 ** Math.max(0, misses - 1), MISS_BACKOFF_MAX_MS);
}

// Consecutive watch hits that produced no download, across all watches. A run
// of OUTAGE_THRESHOLD means the download path itself is likely broken (premium
// session, file host, browser) — alert once per run; any download resets it.
let _missStreak = [];
let _outageAlerted = false;
function noteDeliveryOutcome(downloaded, info) {
  if (downloaded) {
    _missStreak = [];
    _outageAlerted = false;
    return;
  }
  _missStreak.push(info);
  if (_missStreak.length >= OUTAGE_THRESHOLD && !_outageAlerted) {
    _outageAlerted = true;
    const recent = _missStreak.slice(-OUTAGE_THRESHOLD);
    sendOutageAlert(recent).catch((err) => console.warn('[watcher] outage alert failed:', err.message));
  }
}

async function sendOutageAlert(recent) {
  const to = operatorEmail();
  console.warn('[watcher] %d watch hits in a row with no download — download path may be broken', recent.length);
  if (!to || !smtp.isConfigured()) return;
  const lines = recent.map((m) => `• ${m.title}: ${m.reason}`);
  await smtp.getTransport().sendMail({
    from: smtp.FROM,
    to,
    subject: `⚠️ BookHunt: ${recent.length} watch matches in a row failed to download`,
    text:
      `The watchlist found ${recent.length} books in a row but couldn't download any of them, ` +
      `which usually means the download path is broken (premium session, file host, or browser) ` +
      `rather than bad luck. The watches will retry automatically.\n\n${lines.join('\n')}`,
  });
  console.log('[watcher] outage alert sent to %s', to);
}

function _resetOutageState() {
  _missStreak = [];
  _outageAlerted = false;
}

let _inFlight = false;
async function tick() {
  if (_inFlight) return; // don't stack ticks
  _inFlight = true;
  try {
    const due = watchlist.dueWatchesMixed(
      watchlist.readAll(),
      Date.now(),
      settings.getWatchIntervalMs(),
      LIST_RECHECK_FLOOR_MS
    );
    if (!due.length) return;
    const st = await searcher.sessionStatus(); // passive — no navigation
    if (!st.ready) return; // wait for autowarm to restore the session
    const watch = due[0]; // one per tick — politeness
    try {
      await checkWatch(watch);
    } catch (err) {
      if (err && err.cancelled) return; // never happens here (no signal), but safe
      watchlist.update(watch.id, {
        lastCheckedAt: new Date().toISOString(),
        lastError: (err && err.message) || 'check failed',
      });
      console.warn('[watcher] check failed for %s: %s', watch.id, err && err.message);
    }
  } catch (err) {
    console.warn('[watcher] tick failed:', err.message);
  } finally {
    _inFlight = false;
  }
}

/** Force an immediate check of one watch (the "Check now" button). */
async function checkNow(id) {
  const watch = watchlist.readAll().find((w) => w.id === id);
  if (!watch) throw new Error('Watch not found');
  // Only an ACTIVE watch may be checked. A verified hit makes checkWatch()
  // call watchlist.remove() — so running this on a paused/expired/fulfilled
  // watch could silently delete it out from under the user. `notActive`
  // mirrors the existing `needWarm` convention: the route maps it to a 409.
  if (watch.status !== 'active') {
    throw Object.assign(new Error('Resume this watch before checking it.'), { notActive: true });
  }
  // Share tick()'s concurrency guard: two overlapping "Check now" clicks, or
  // a "Check now" racing the scheduler's own tick, must not both run against
  // the shared browser session at once.
  if (_inFlight) {
    throw new Error('A check is already running — try again in a moment.');
  }
  _inFlight = true;
  try {
    return await checkWatch(watch);
  } finally {
    _inFlight = false;
  }
}

let _timer = null;
function start() {
  if (process.env.WATCH_ENABLED === 'false') {
    console.log('[watcher] disabled (WATCH_ENABLED=false)');
    return;
  }
  if (_timer) return;
  _timer = setInterval(tick, TICK_MS);
  if (_timer.unref) _timer.unref(); // don't keep the process alive just for this
  console.log(
    `[watcher] watchlist scheduler on — tick ${TICK_MS / 1000}s, re-check each watch every ${settings.getWatchIntervalMin()}min (configurable in Settings)`
  );
}

module.exports = {
  start, tick, checkWatch, checkNow, autoDeliver, operatorEmail,
  // exported for unit tests
  missBackoffMs, summarizeDownloadErrors, noteDeliveryOutcome, _resetOutageState,
  MAX_DOWNLOAD_MISSES, OUTAGE_THRESHOLD,
};
