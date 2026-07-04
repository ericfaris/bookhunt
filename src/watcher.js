'use strict';

// Background scheduler for the watchlist (issue #7). Periodically re-runs each
// active watch through the SAME search pipeline as interactive search, and on the
// first match notifies the user (email, with cover + thread link) and marks the
// watch fulfilled.
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

const TICK_MS = Number(process.env.WATCH_TICK_MS) || 300000; // wake every 5 min
// List-origin watches never re-check faster than this, whatever the user's
// watchlist cadence — bestseller lists refresh weekly, and dozens of radar
// watches on a tight cadence would be impolite to the forum.
const LIST_RECHECK_FLOOR_MS = Number(process.env.LIST_RECHECK_FLOOR_MS) || 24 * 3600 * 1000;
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
 * Autonomously deliver a matched book (issue #7 follow-up): when the match is a
 * premium ePUB and credentials are set, download + verify it, push it to each
 * recipient's Kindle, and email everyone. If a download isn't possible (no
 * premium / no creds / unverified / wrong-book), gracefully fall back to a
 * notify-only email with the thread link so nothing is ever silently dropped.
 * Always emails the operator. Never throws.
 *
 * Returns { downloaded, delivered, kindlePushed }.
 */
async function autoDeliver(watch, top) {
  const book = {
    title: top.title || watch.title,
    author: top.author || watch.author,
    cover: top.cover || null,
    description: top.description || '',
    link: top.url || null,
    watch: true,
  };
  const targets = deliveryRecipients(watch);

  // 1) Try an autonomous, verified premium download.
  let download = null;
  if (top.premium && top.url && downloader.hasPremiumCreds()) {
    try {
      const r = await downloader.premiumDownload(top.url, () => {}, watch.title || top.title);
      download = (r.downloads || []).find((d) => d.verified) || null;
      // Safety: never auto-send a book whose embedded title clearly mismatches.
      if (download && download.titleMatch === false) {
        console.warn('[watcher] downloaded "%s" but embedded title mismatched — not auto-sending', book.title);
        download = null;
      }
    } catch (err) {
      console.warn('[watcher] auto-download failed for "%s": %s', book.title, err.message);
    }
  }

  // 2) Log a real download to history/Library so it behaves like a manual one.
  if (download) {
    try {
      history.logDownload({
        title: book.title, author: book.author, cover: book.cover,
        filename: download.filename, savePath: download.savePath, url: top.url,
        mode: 'premium', verified: download.verified, size: download.size,
      });
    } catch { /* best effort */ }
    // List-origin watches carry tags so the Library groups auto-acquisitions.
    if (Array.isArray(watch.tags) && watch.tags.length && download.savePath) {
      try { booktags.setTags(download.savePath, watch.tags); } catch { /* best effort */ }
    }
  }

  // 3) Deliver to recipients: push the file to Kindle (when we have it + an
  // address), then email them. Dedup emails so the operator isn't doubled up.
  let delivered = 0;
  let kindlePushed = 0;
  const emailed = new Set();
  for (const r of targets) {
    let pushed = false;
    if (download && r.kindleEmail) {
      try {
        await kindle.pushToKindle({ kindleEmail: r.kindleEmail, filePath: download.savePath, filename: download.filename });
        pushed = true;
        kindlePushed++;
      } catch (err) {
        console.warn('[watcher] Kindle push failed for %s: %s', r.kindleEmail, err.message);
      }
    }
    if (r.email) {
      try {
        await notify.notify(r, { ...book, pushedToKindle: pushed }, ['email']);
        emailed.add(String(r.email).toLowerCase());
        delivered++;
      } catch (err) {
        console.warn('[watcher] notify failed for %s: %s', r.email, err.message);
      }
    }
  }

  // 4) Always tell the operator (unless they were already emailed as a
  // recipient). List-origin watches stay quiet here — their outcome lands in
  // the radar's digest email instead of one email per book.
  const op = watch.source === 'list' ? '' : operatorEmail();
  if (op && !emailed.has(op.toLowerCase())) {
    try {
      await notify.notify({ email: op, name: '' }, { ...book, pushedToKindle: false }, ['email']);
    } catch (err) {
      console.warn('[watcher] operator notify failed: %s', err.message);
    }
  }

  return { downloaded: !!download, delivered, kindlePushed };
}

/**
 * Run one watch through the search pipeline. On a match: notify + mark fulfilled.
 * Always records lastCheckedAt/checkCount. Returns { matched, notifyResults? }.
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
    let delivery = { downloaded: false, delivered: 0, kindlePushed: 0 };
    try {
      delivery = await autoDeliver(watch, top);
    } catch (err) {
      console.warn('[watcher] delivery failed for %s: %s', watch.id, err.message);
    }
    watchlist.update(watch.id, {
      ...base,
      status: 'fulfilled',
      foundUrl: top.url || null,
      foundAt: new Date().toISOString(),
      delivered: delivery.delivered,
      kindlePushed: delivery.kindlePushed,
      downloaded: delivery.downloaded,
    });
    try {
      history.add({
        type: 'watch-hit',
        title: top.title || watch.title,
        author: top.author || watch.author,
        url: top.url || null,
        status: 'fulfilled',
      });
    } catch { /* best effort */ }
    // Feed the radar's digest: verified acquisition vs. found-but-unverified.
    if (watch.source === 'list') {
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
      '[watcher] match for "%s" — %s, emailed %d, kindle %d',
      watch.title || watch.author,
      delivery.downloaded ? 'downloaded' : 'notify-only',
      delivery.delivered,
      delivery.kindlePushed
    );
    return { matched: true, delivery };
  }

  watchlist.update(watch.id, base);
  return { matched: false };
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
  return checkWatch(watch);
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

module.exports = { start, tick, checkWatch, checkNow, autoDeliver, operatorEmail };
