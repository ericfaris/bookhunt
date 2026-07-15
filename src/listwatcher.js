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
const library = require('./library');
const settings = require('./settings');
const smtp = require('./smtp');
const covers = require('./covers');

const TICK_MS = Number(process.env.LISTS_TICK_MS) || 3600000; // hourly wake; runs when the pull is due

// Politeness backstop: the scraped Goodreads pages churn much faster than the
// NYT lists, so unchecked accumulation could grow into a hundred daily forum
// searches. Above this many ACTIVE list watches, new entrants are skipped
// (recorded in the digest) rather than watched. This is the standing-pool
// ceiling; the per-pull intake cap (settings.getListMaxPerRun) smooths how fast
// the pool fills, so this can stay modest.
const LIST_MAX_ACTIVE = Number(process.env.LIST_MAX_ACTIVE) || 40;

// One-time Most Read backfill (see lists.js): a smaller daily rate than the
// live radar's per-pull intake cap, so the backfill only ever spends the
// budget the live radar's new-entrant pass leaves unused each run.
const BACKFILL_MAX_PER_RUN = Number(process.env.BACKFILL_MAX_PER_RUN) || 5;

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

/**
 * PURE: decide what to do with one not-yet-seen new entrant, given the current
 * counters. Ordering is the contract:
 *   'owned'     — already on the shelf; never watch (checked first).
 *   'skip-full' — standing watch pool is at the ceiling; hard stop (marked seen,
 *                 not retried).
 *   'defer'     — this pull's intake budget is spent; skip WITHOUT marking seen
 *                 so the entrant is retried on the next pull.
 *   'watch'     — create the watch.
 */
function classifyEntrant({ owned, activeCount, maxActive, watchedThisRun, maxPerRun }) {
  if (owned) return 'owned';
  if (activeCount >= maxActive) return 'skip-full';
  if (watchedThisRun >= maxPerRun) return 'defer';
  return 'watch';
}

/**
 * PURE: how many backfill entries to draw THIS run — the live radar's
 * new-entrant pass claims the per-pull intake budget first; backfill spends
 * only what's left over, capped at its own smaller daily rate and at what's
 * actually queued. Never negative.
 */
function backfillDrawCount({ watchedThisRun, maxPerRun, backfillMaxPerRun, queueLength }) {
  return Math.max(0, Math.min(backfillMaxPerRun, maxPerRun - watchedThisRun, queueLength));
}

/**
 * PURE: decide what to do with one backfill queue entry. Mirrors
 * classifyEntrant's owned/pool-full/watch branches, but deliberately DIVERGES
 * on pool-full: backfill entries are 'defer' (retried next run), never the
 * live radar's permanent 'skip-full' — a one-time catch-up queue shouldn't
 * silently drop titles just because the standing pool was briefly full. The
 * per-run intake budget itself is enforced by backfillDrawCount, not here.
 */
function classifyBackfillEntry({ owned, activeCount, maxActive }) {
  if (owned) return 'owned';
  if (activeCount >= maxActive) return 'defer';
  return 'watch';
}

/**
 * Drain the one-time Most Read backfill queue by up to this run's leftover
 * intake budget. Not pure (I/O via watchlist/library), but every decision is
 * delegated to backfillDrawCount/classifyBackfillEntry. `state.backfill` is
 * mutated in place; the caller's single `lists.writeState(state)` persists it.
 * Returns the updated `{ activeListWatches, watchedThisRun }` counters so the
 * caller's politeness/intake bookkeeping stays accurate.
 */
function drainBackfill(state, summary, { activeListWatches, watchedThisRun, maxPerRun }) {
  const backfill = state.backfill;
  const draw = backfillDrawCount({
    watchedThisRun,
    maxPerRun,
    backfillMaxPerRun: BACKFILL_MAX_PER_RUN,
    queueLength: backfill.queue.length,
  });

  // Rebuild activeKeys fresh (not the queue-build-time snapshot) to catch
  // watches added since — avoids double-watching / relabel-clobbering a
  // hand-added watch (see watchlist.add()'s active-watch dedupe).
  const activeKeys = new Set(
    watchlist.readAll().filter((w) => w.status === 'active').map(watchlist.queryKey)
  );

  summary.backfilled = summary.backfilled || [];
  let drawn = 0;
  while (drawn < draw && backfill.queue.length) {
    const entry = backfill.queue[0];
    const key = watchlist.queryKey(entry);
    if (activeKeys.has(key)) {
      // Already actively watched (added since queue-build) — resolved,
      // silently drop; don't relabel the existing watch.
      backfill.queue.shift();
      continue;
    }
    const decision = classifyBackfillEntry({
      owned: library.ownsBook(entry),
      activeCount: activeListWatches,
      maxActive: LIST_MAX_ACTIVE,
    });
    if (decision === 'owned') {
      backfill.queue.shift();
      backfill.ownedCount++;
      continue;
    }
    if (decision === 'defer') {
      // Standing pool is full — nothing else will fit this run either.
      break;
    }
    try {
      const watch = watchlist.add({ title: entry.title, author: entry.author, sort: 'newest' });
      watchlist.update(watch.id, {
        source: 'list',
        listLabel: lists.BACKFILL_LABEL,
        tags: [lists.LIST_TAGS[0], lists.BACKFILL_TAG],
      });
      activeKeys.add(key);
      activeListWatches++;
      watchedThisRun++;
      drawn++;
      backfill.queue.shift();
      backfill.watchedCount++;
      state.pendingEvents.push({
        at: new Date().toISOString(), type: 'watching',
        title: entry.title, author: entry.author, list: lists.BACKFILL_LABEL,
      });
      summary.backfilled.push(entry.title);
    } catch (err) {
      console.warn('[lists] backfill could not watch "%s": %s', entry.title, err.message);
      summary.errors.push({ list: lists.BACKFILL_LABEL, error: `${entry.title}: ${err.message}` });
      break; // leave entry in queue; avoid a tight retry loop on a persistent error
    }
  }

  if (backfill.queue.length === 0 && backfill.status === 'running') {
    backfill.status = 'done';
    backfill.finishedAt = new Date().toISOString();
    state.pendingEvents.push({ at: new Date().toISOString(), type: 'backfill-done', count: backfill.watchedCount });
  }

  return { activeListWatches, watchedThisRun };
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
  // burst across sources can't blow past the standing ceiling.
  let activeListWatches = watchlist.readAll().filter((w) => w.source === 'list' && w.status === 'active').length;

  // Per-pull intake cap: bound how many watches THIS run creates so a churny
  // Goodreads reshuffle can't add a dozen at once. Overflow is recorded as
  // 'skipped' (with reason) but NOT marked seen, so it's re-evaluated next pull.
  const maxPerRun = settings.getListMaxPerRun();
  let watchedThisRun = 0;

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
      // Entries deferred by the per-pull intake cap this run — excluded from the
      // snapshot below so they count as new entrants again next pull.
      const deferredKeys = new Set();
      for (const entry of lists.newEntrants(prevKeys, entries)) {
        const key = lists.entryKey(entry);
        // The seen map is updated as we go, so a book surfacing on several
        // sources in the SAME run is still processed exactly once.
        if (state.seen[key]) continue;
        const decision = classifyEntrant({
          owned: library.ownsBook(entry),
          activeCount: activeListWatches,
          maxActive: LIST_MAX_ACTIVE,
          watchedThisRun,
          maxPerRun,
        });
        if (decision === 'owned') {
          state.seen[key] = { at: new Date().toISOString(), list: source.label, disposition: 'owned' };
          summary.owned.push(entry.title);
          continue;
        }
        if (decision === 'skip-full') {
          // Standing pool is full — skip permanently (mark seen). Freed by the
          // 8-week expiry, but we don't retry a specific title after that.
          state.seen[key] = { at: new Date().toISOString(), list: source.label, disposition: 'skipped' };
          state.pendingEvents.push({
            at: new Date().toISOString(), type: 'skipped', note: 'watch queue is full',
            title: entry.title, author: entry.author, list: source.label,
          });
          summary.skipped.push(entry.title);
          continue;
        }
        if (decision === 'defer') {
          // Daily intake budget spent. DON'T mark seen and DON'T let the snapshot
          // swallow it (deferredKeys, below) — so it re-surfaces as a new entrant
          // on the next pull and gets another shot at a slot.
          deferredKeys.add(key);
          state.pendingEvents.push({
            at: new Date().toISOString(), type: 'skipped', note: 'daily intake limit reached',
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
          watchedThisRun++;
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
      // Persist the pull, but drop the entries we deferred so they re-surface as
      // new entrants next pull (see deferredKeys / the per-pull intake cap).
      state.snapshots[source.id] = {
        pulledAt: new Date().toISOString(),
        entries: deferredKeys.size ? entries.filter((e) => !deferredKeys.has(lists.entryKey(e))) : entries,
      };
      continue;
    }
    state.snapshots[source.id] = { pulledAt: new Date().toISOString(), entries };
  }

  // One-time Most Read backfill: drains AFTER the live radar's new-entrant
  // loop above, so live entrants have already spent this run's intake budget
  // (live-first priority — see backfillDrawCount). Only runs when a backfill
  // queue is actually in progress.
  if (state.backfill && state.backfill.status === 'running' && state.backfill.queue.length) {
    const drained = drainBackfill(state, summary, { activeListWatches, watchedThisRun, maxPerRun });
    activeListWatches = drained.activeListWatches;
    watchedThisRun = drained.watchedThisRun;
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
    '[lists] run done — %d watching, %d owned, %d skipped, %d expired, %d backfilled, digest %s',
    summary.watching.length, summary.owned.length, summary.skipped.length, summary.expired.length,
    (summary.backfilled || []).length, summary.digested ? 'sent' : 'not sent'
  );
  return summary;
}

// --- digest email ------------------------------------------------------------

const SECTIONS = [
  { type: 'added', head: 'Added to your Library', line: (e) => `${e.title}${e.author ? ' — ' + e.author : ''}` },
  { type: 'watching', head: 'Now watching — not yet available on Mobilism', line: (e) => `${e.title}${e.author ? ' — ' + e.author : ''} (${e.list})` },
  { type: 'backfill-done', head: 'Backfill complete', line: (e) => `Most Read backfill finished — ${e.count || 0} added to your watchlist` },
  { type: 'unverified', head: 'Found but couldn’t verify — not added', line: (e) => `${e.title}${e.author ? ' — ' + e.author : ''}` },
  { type: 'expired', head: 'Stopped watching — never became available', line: (e) => `${e.title}${e.author ? ' — ' + e.author : ''}` },
  { type: 'skipped', head: 'Skipped', line: (e) => `${e.title}${e.author ? ' — ' + e.author : ''} (${e.list}${e.note ? ' · ' + e.note : ''})` },
];

// Sections whose books get a cover thumbnail (the interesting ones); the
// housekeeping sections (unverified/expired/skipped) stay as plain lists.
const COVER_SECTIONS = new Set(['added', 'watching']);

/** PURE: pending events → { subject, text, html, attachments } (null when
 *  nothing to say). Events may carry a `cover` URL (see sendDigest); covers
 *  ride as inline CID images so they render even when a client blocks remote
 *  images, matching the reader emails. */
function buildDigest(events) {
  const byType = (t) => (events || []).filter((e) => e.type === t);
  if (!events || !events.length) return null;
  const added = byType('added').length;
  const watching = byType('watching').length;

  const bits = [];
  if (added) bits.push(`${added} added`);
  if (watching) bits.push(`${watching} now watched`);
  const subject = `BookHunt new releases — ${bits.length ? bits.join(', ') : 'activity summary'}`;

  const textParts = [];
  const bodyRows = [];
  const attachments = [];
  for (const s of SECTIONS) {
    const evs = byType(s.type);
    if (!evs.length) continue;
    textParts.push(`${s.head}\n${evs.map((e) => `  • ${s.line(e)}`).join('\n')}`);
    const head = `<p style="margin:0 0 8px;font-size:15px;font-weight:700;color:#1c2a56">${s.head}</p>`;
    if (COVER_SECTIONS.has(s.type)) {
      const rows = evs.map((e) => {
        let coverCell;
        if (/^https?:\/\//i.test(String(e.cover || ''))) {
          const cid = `cover${attachments.length}@radar`;
          attachments.push({ filename: `cover${attachments.length}.jpg`, path: e.cover, cid });
          coverCell = `<img src="cid:${cid}" alt="" width="54"
            style="width:54px;height:auto;display:block;border-radius:7px;box-shadow:0 3px 10px rgba(0,0,0,0.18)">`;
        } else {
          coverCell = `<div style="width:54px;height:80px;border-radius:7px;
            background:linear-gradient(135deg,#1c2a56,#2a3a72);text-align:center;line-height:80px;font-size:24px">📖</div>`;
        }
        const sub = [e.author, e.list].filter(Boolean).join(' · ');
        return `<tr>
          <td valign="top" width="54" style="padding:0 16px 14px 0">${coverCell}</td>
          <td valign="top" style="padding:0 0 14px">
            <p style="margin:0 0 3px;font-size:15px;font-weight:700;color:#1c2a56;line-height:1.3">${escapeHtml(e.title)}</p>
            ${sub ? `<p style="margin:0;font-size:13px;color:#6b727e;line-height:1.4">${escapeHtml(sub)}</p>` : ''}
          </td>
        </tr>`;
      }).join('');
      bodyRows.push(
        `<tr><td style="padding:14px 28px 0">${head}` +
        `<table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rows}</table></td></tr>`
      );
    } else {
      bodyRows.push(
        `<tr><td style="padding:14px 28px 0">${head}` +
        `<ul style="margin:0;padding-left:20px;font-size:14px;color:#6b727e;line-height:1.7">` +
        evs.map((e) => `<li>${escapeHtml(s.line(e))}</li>`).join('') + '</ul></td></tr>'
      );
    }
  }
  bodyRows.push('<tr><td style="padding:0 0 18px"></td></tr>');
  const { emailShell } = require('./reader'); // lazy, matching this module's style
  const html = emailShell(
    'New-release radar',
    bodyRows.join(''),
    'Compiled from the NYT bestseller and Goodreads adult-fiction lists. To remove a title, delete it from your Library.',
    'Automated digest from your BookHunt server'
  );
  return { subject, text: textParts.join('\n\n'), html, attachments };
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
  // Enrich the cover-worthy events with a cover URL (disk-cached lookup;
  // resolveCover never throws — a miss just leaves the placeholder).
  for (const e of events) {
    if (COVER_SECTIONS.has(e.type) && !e.cover) {
      e.cover = await covers.resolveCover({ title: e.title, author: e.author });
    }
  }
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

module.exports = {
  start, tick, run, sendDigest, scheduleDigestSoon, buildDigest, classifyEntrant, operatorEmail,
  backfillDrawCount, classifyBackfillEntry, drainBackfill, BACKFILL_MAX_PER_RUN,
};
