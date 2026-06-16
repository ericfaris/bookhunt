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

const TICK_MS = Number(process.env.WATCH_TICK_MS) || 300000; // wake every 5 min
const CHECK_INTERVAL_MS = Number(process.env.WATCH_CHECK_INTERVAL_MS) || 1800000; // re-check a watch every 30 min

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

// Notify the operator (always, if configured) plus any recipients the watch
// targeted. Email-only — a watch hit is "go grab it", not a file push.
async function notifyMatch(watch, book) {
  const results = [];
  const op = operatorEmail();
  if (op) {
    try {
      results.push(...(await notify.notify({ email: op, name: '' }, book, ['email'])));
    } catch (err) {
      results.push({ channel: 'email', ok: false, error: err.message });
    }
  }
  if (watch.recipientIds && watch.recipientIds.length) {
    const recips = recipients.byIds(watch.recipientIds);
    for (const r of recips) {
      try {
        results.push(...(await notify.notify(r, book, ['email'])));
      } catch (err) {
        results.push({ channel: 'email', ok: false, error: err.message });
      }
    }
  }
  return results;
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
    const book = {
      title: top.title || watch.title,
      author: top.author || watch.author,
      cover: top.cover || null,
      description: top.description || '',
      link: top.url || null,
      watch: true,
    };
    let notifyResults = [];
    try {
      notifyResults = await notifyMatch(watch, book);
    } catch (err) {
      console.warn('[watcher] notify failed for %s: %s', watch.id, err.message);
    }
    watchlist.update(watch.id, { ...base, status: 'fulfilled', foundUrl: top.url || null, foundAt: new Date().toISOString() });
    try {
      history.add({ type: 'watch-hit', title: book.title, author: book.author, url: book.link, status: 'fulfilled' });
    } catch { /* best effort */ }
    console.log('[watcher] match for "%s" — notified + fulfilled', watch.title || watch.author);
    return { matched: true, notifyResults };
  }

  watchlist.update(watch.id, base);
  return { matched: false };
}

let _inFlight = false;
async function tick() {
  if (_inFlight) return; // don't stack ticks
  _inFlight = true;
  try {
    const due = watchlist.dueWatches(watchlist.readAll(), Date.now(), CHECK_INTERVAL_MS);
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
    `[watcher] watchlist scheduler on — tick ${TICK_MS / 1000}s, re-check each watch every ${CHECK_INTERVAL_MS / 60000}min`
  );
}

module.exports = { start, tick, checkWatch, checkNow, notifyMatch, operatorEmail };
