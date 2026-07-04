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

  const summary = { pulled: [], seeded: [], watching: [], owned: [], expired: [], errors: [] };

  for (const list of lists.NYT_LISTS) {
    let entries;
    try {
      entries = await lists.fetchList(list.id);
    } catch (err) {
      console.warn('[lists] pull failed for %s: %s', list.id, err.message);
      summary.errors.push({ list: list.label, error: err.message });
      continue; // keep the old snapshot so nothing is treated as "new" next time
    }
    summary.pulled.push({ list: list.label, count: entries.length });

    const prev = state.snapshots[list.id];
    if (!prev) {
      // First ever pull: baseline only. Acting on it would dump the whole
      // current list into the watchlist at once.
      summary.seeded.push(list.label);
    } else {
      for (const entry of lists.newEntrants(prev.keys, entries)) {
        const key = lists.entryKey(entry);
        if (state.seen[key]) continue; // handled via another list / earlier week
        if (inLibrary(entry)) {
          state.seen[key] = { at: new Date().toISOString(), list: list.label, disposition: 'owned' };
          summary.owned.push(entry.title);
          continue;
        }
        try {
          const watch = watchlist.add({ title: entry.title, author: entry.author, sort: 'newest' });
          watchlist.update(watch.id, {
            source: 'list',
            listLabel: list.label,
            tags: [...lists.LIST_TAGS, list.label.startsWith('NYT') ? 'NYT Fiction' : list.label],
          });
          state.seen[key] = { at: new Date().toISOString(), list: list.label, disposition: 'watching' };
          state.pendingEvents.push({
            at: new Date().toISOString(), type: 'watching',
            title: entry.title, author: entry.author, list: list.label,
          });
          summary.watching.push(entry.title);
        } catch (err) {
          console.warn('[lists] could not watch "%s": %s', entry.title, err.message);
          summary.errors.push({ list: list.label, error: `${entry.title}: ${err.message}` });
        }
      }
    }
    state.snapshots[list.id] = { pulledAt: new Date().toISOString(), keys: entries.map(lists.entryKey) };
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
    '[lists] run done — %d watching, %d owned, %d expired, digest %s',
    summary.watching.length, summary.owned.length, summary.expired.length,
    summary.digested ? 'sent' : 'skipped'
  );
  return summary;
}

// --- digest email ------------------------------------------------------------

const SECTIONS = [
  { type: 'added', head: '📚 Added to your Library', line: (e) => `${e.title}${e.author ? ' — ' + e.author : ''}` },
  { type: 'watching', head: '👀 Now watching (not on Mobilism yet)', line: (e) => `${e.title}${e.author ? ' — ' + e.author : ''} (${e.list})` },
  { type: 'unverified', head: '⚠ Found but couldn’t verify — not added', line: (e) => `${e.title}${e.author ? ' — ' + e.author : ''}` },
  { type: 'expired', head: '🕰 Stopped watching (never appeared)', line: (e) => `${e.title}${e.author ? ' — ' + e.author : ''}` },
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
  htmlParts.push('<p style="color:#888;font-size:12px;margin-top:20px">Sourced from the NYT fiction bestseller lists. Unwanted books are one 🗑 away in the Library.</p></div>');
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
  console.log(
    `[lists] new-release radar on — pull every ${settings.getListPullIntervalHours()}h (configurable in Settings)`
  );
}

module.exports = { start, tick, run, sendDigest, scheduleDigestSoon, buildDigest, operatorEmail };
