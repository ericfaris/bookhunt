'use strict';

// Scheduler for the new-release list radar (issue #33). On its cadence it
// pulls each NYT list, seeds a baseline on the first ever pull (silently — no
// 60-book dump), and turns week-over-week NEW entrants into watchlist watches
// (source: 'list'). The existing watcher then acquires them autonomously —
// verified download → Library, tagged — one per tick, so acquisition politeness
// is inherited rather than reimplemented.
//
// Digesting: everything noteworthy (now watching / added to Library / found but
// unverified / expired) is queued as an event in lists.json; each run drains
// the queue into ONE digest email to the operator. Quiet week → no email.

const lists = require('./lists');
const watchlist = require('./watchlist');
const history = require('./history');
const library = require('./library');
const booktags = require('./booktags');
const settings = require('./settings');
const smtp = require('./smtp');

const TICK_MS = Number(process.env.LISTS_TICK_MS) || 3600000; // hourly wake; runs when the pull is due

// Politeness backstop: the Amazon/Goodreads charts churn much faster than the
// NYT lists, so unchecked accumulation could grow into a hundred daily forum
// searches. Above this many ACTIVE list watches, new entrants are skipped
// (recorded in the digest) rather than watched.
const LIST_MAX_ACTIVE = Number(process.env.LIST_MAX_ACTIVE) || 75;

function operatorEmail() {
  // Same resolution as the watcher/autowarm: explicit override → CF-Access
  // email → SMTP identity.
  const allowed = (process.env.CF_ACCESS_ALLOWED_EMAILS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return (
    process.env.LISTS_ALERT_EMAIL ||
    process.env.WATCH_ALERT_EMAIL ||
    allowed[0] ||
    process.env.SMTP_FROM ||
    process.env.SMTP_USER ||
    ''
  );
}

/** Is this book already on the shelf? (Never re-acquire library books.) */
function inLibrary(entry) {
  try {
    const books = library.buildLibrary(history.readAll(), (p) => booktags.readStore()[booktags.keyFor(p)] || []);
    return library.findInLibrary(books, entry).length > 0;
  } catch {
    return false; // fail open — worst case we watch a book we own
  }
}

/**
 * One full radar run: pull lists → diff → enqueue watches → expire stale
 * watches → send the digest. Returns a summary for the API/UI. Never throws
 * for per-list failures (a broken source shouldn't kill the others).
 */
async function run({ force = false } = {}) {
  if (!lists.isConfigured()) return { skipped: 'NYT_API_KEY not set' };
  if (!settings.getListsEnabled()) return { skipped: 'disabled in Settings' };

  const state = lists.readState();
  const due = force || !state.lastRunAt ||
    Date.now() - Date.parse(state.lastRunAt) >= settings.getListPullIntervalMs();
  if (!due) return { skipped: 'not due yet' };

  const summary = { pulled: [], seeded: [], watching: [], owned: [], skipped: [], expired: [], errors: [] };

  // Politeness cap counter — includes watches created earlier in this run so a
  // burst across sources can't blow past the limit.
  let activeListWatches = watchlist.readAll().filter((w) => w.source === 'list' && w.status === 'active').length;

  for (const source of lists.sources()) {
    if (!source.configured) continue;
    let entries;
    try {
      entries = await source.fetch();
    } catch (err) {
      console.warn('[lists] pull failed for %s: %s', source.id, err.message);
      summary.errors.push({ list: source.label, error: err.message });
      continue; // keep the old snapshot so nothing is treated as "new" next time
    }
    summary.pulled.push({ list: source.label, count: entries.length });

    const prev = state.snapshots[source.id];
    if (!prev) {
      // First ever pull of this source: baseline only. Acting on it would dump
      // the whole current list into the watchlist at once.
      summary.seeded.push(source.label);
    } else {
      const prevKeys = (prev.entries || []).map(lists.entryKey);
      for (const entry of lists.newEntrants(prevKeys, entries)) {
        const key = lists.entryKey(entry);
        // The seen map is updated as we go, so a book surfacing on several
        // sources in the SAME run is still processed exactly once.
        if (state.seen[key]) continue;
        if (inLibrary(entry)) {
          state.seen[key] = { at: new Date().toISOString(), list: source.label, disposition: 'owned' };
          summary.owned.push(entry.title);
          continue;
        }
        if (activeListWatches >= LIST_MAX_ACTIVE) {
          state.seen[key] = { at: new Date().toISOString(), list: source.label, disposition: 'skipped' };
          state.pendingEvents.push({
            at: new Date().toISOString(), type: 'skipped',
            title: entry.title, author: entry.author, list: source.label,
          });
          summary.skipped.push(entry.title);
          continue;
        }
        try {
          const watch = watchlist.add({ title: entry.title, author: entry.author, sort: 'newest' });
          watchlist.update(watch.id, {
            source: 'list',
            listLabel: source.label,
            tags: [...lists.LIST_TAGS, source.tag],
          });
          activeListWatches++;
          state.seen[key] = { at: new Date().toISOString(), list: source.label, disposition: 'watching' };
          state.pendingEvents.push({
            at: new Date().toISOString(), type: 'watching',
            title: entry.title, author: entry.author, list: source.label,
          });
          summary.watching.push(entry.title);
        } catch (err) {
          console.warn('[lists] could not watch "%s": %s', entry.title, err.message);
          summary.errors.push({ list: source.label, error: `${entry.title}: ${err.message}` });
        }
      }
    }
    state.snapshots[source.id] = { pulledAt: new Date().toISOString(), entries };
  }

  // Expire list watches that never matched.
  for (const w of lists.expiredListWatches(watchlist.readAll(), Date.now())) {
    watchlist.update(w.id, { status: 'expired' });
    state.pendingEvents.push({
      at: new Date().toISOString(), type: 'expired',
      title: w.title, author: w.author, list: w.listLabel || '',
    });
    summary.expired.push(w.title);
  }

  state.lastRunAt = new Date().toISOString();
  lists.writeState(state);

  try {
    summary.digested = await sendDigest();
  } catch (err) {
    console.warn('[lists] digest failed: %s', err.message);
    summary.errors.push({ list: 'digest', error: err.message });
  }

  console.log(
    '[lists] run done — %d watching, %d owned, %d skipped, %d expired, digest %s',
    summary.watching.length, summary.owned.length, summary.skipped.length, summary.expired.length,
    summary.digested ? 'sent' : 'not sent'
  );
  return summary;
}

// --- digest email ------------------------------------------------------------

const SECTIONS = [
  { type: 'added', head: '📚 Added to your Library', line: (e) => `${e.title}${e.author ? ' — ' + e.author : ''}` },
  { type: 'watching', head: '👀 Now watching (not on Mobilism yet)', line: (e) => `${e.title}${e.author ? ' — ' + e.author : ''} (${e.list})` },
  { type: 'unverified', head: '⚠ Found but couldn’t verify — not added', line: (e) => `${e.title}${e.author ? ' — ' + e.author : ''}` },
  { type: 'expired', head: '🕰 Stopped watching (never appeared)', line: (e) => `${e.title}${e.author ? ' — ' + e.author : ''}` },
  { type: 'skipped', head: '⏸ Skipped — watch queue is full', line: (e) => `${e.title}${e.author ? ' — ' + e.author : ''} (${e.list})` },
];

/** PURE: pending events → { subject, text, html } (null when nothing to say). */
function buildDigest(events) {
  const byType = (t) => (events || []).filter((e) => e.type === t);
  if (!events || !events.length) return null;
  const added = byType('added').length;
  const watching = byType('watching').length;

  const bits = [];
  if (added) bits.push(`${added} added`);
  if (watching) bits.push(`${watching} now watched`);
  const subject = `📖 BookHunt new releases — ${bits.length ? bits.join(', ') : 'list activity'}`;

  const textParts = [];
  const htmlParts = ['<div style="font-family:sans-serif;max-width:640px">', '<h2 style="margin:0 0 12px">BookHunt new-release radar</h2>'];
  for (const s of SECTIONS) {
    const evs = byType(s.type);
    if (!evs.length) continue;
    textParts.push(`${s.head}\n${evs.map((e) => `  • ${s.line(e)}`).join('\n')}`);
    htmlParts.push(
      `<h3 style="margin:16px 0 6px">${s.head}</h3><ul style="margin:0;padding-left:20px">` +
      evs.map((e) => `<li>${escapeHtml(s.line(e))}</li>`).join('') + '</ul>'
    );
  }
  htmlParts.push('<p style="color:#888;font-size:12px;margin-top:20px">Sourced from NYT bestseller, Amazon new-release, and Goodreads popular fiction lists. Unwanted books are one 🗑 away in the Library.</p></div>');
  return { subject, text: textParts.join('\n\n'), html: htmlParts.join('') };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Drain pending events into one operator email. Returns true when sent. */
async function sendDigest() {
  if (!smtp.isConfigured()) return false;
  const to = operatorEmail();
  if (!to) return false;
  const events = lists.drainEvents();
  const msg = buildDigest(events);
  if (!msg) return false;
  try {
    await smtp.getTransport().sendMail({ from: smtp.FROM, to, ...msg });
    return true;
  } catch (err) {
    // Put the events back so they aren't lost — next run retries.
    const state = lists.readState();
    state.pendingEvents = [...events, ...state.pendingEvents];
    lists.writeState(state);
    throw err;
  }
}

// Debounced flush for events recorded between runs (the watcher acquires one
// book per tick, so a burst of fulfillments batches into one email instead of
// one email per book — and instead of waiting a day for the next pull).
let _digestTimer = null;
function scheduleDigestSoon(delayMs = Number(process.env.LISTS_DIGEST_DEBOUNCE_MS) || 1800000) {
  if (_digestTimer) return;
  _digestTimer = setTimeout(async () => {
    _digestTimer = null;
    try {
      await sendDigest();
      await require('./reader').notifyNewBooks(); // readers hear about acquisitions too
    } catch (err) {
      console.warn('[lists] digest failed: %s', err.message);
    }
  }, delayMs);
  if (_digestTimer.unref) _digestTimer.unref();
}

// --- scheduler ----------------------------------------------------------------

let _inFlight = false;
async function tick() {
  if (_inFlight) return;
  _inFlight = true;
  try {
    await run();
    // Reader portal (issue #34): tell subscribed readers about newly shelved
    // books — radar acquisitions AND manual downloads. Self-throttled per
    // reader, so the hourly tick is a safe place to fire it.
    const notified = await require('./reader').notifyNewBooks();
    if (notified) console.log('[reader] new-book emails sent to %d reader(s)', notified);
  } catch (err) {
    console.warn('[lists] tick failed:', err.message);
  } finally {
    _inFlight = false;
  }
}

let _timer = null;
function start() {
  if (process.env.LISTS_ENABLED === 'false') {
    console.log('[lists] disabled (LISTS_ENABLED=false)');
    return;
  }
  if (!lists.isConfigured()) {
    console.log('[lists] new-release radar off — set NYT_API_KEY to enable');
    return;
  }
  if (_timer) return;
  _timer = setInterval(tick, TICK_MS);
  if (_timer.unref) _timer.unref();
  // First tick shortly after boot so a restart doesn't postpone a due pull.
  const boot = setTimeout(tick, 15000);
  if (boot.unref) boot.unref();
  // The digest debounce timer is in-memory: a restart between an acquisition
  // and its flush would silently park the news until the next daily run. Flush
  // any events that survived the restart soon after boot instead.
  if ((lists.readState().pendingEvents || []).length) scheduleDigestSoon(120000);
  console.log(
    `[lists] new-release radar on — pull every ${settings.getListPullIntervalHours()}h (configurable in Settings)`
  );
}

module.exports = { start, tick, run, sendDigest, scheduleDigestSoon, buildDigest, operatorEmail };
