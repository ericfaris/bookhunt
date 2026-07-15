'use strict';

// New-release list radar (issue #33): pull fiction bestseller/new-release
// lists on a schedule, diff them against the previous pull, and surface only
// the NEW entrants — the listwatcher turns those into watchlist watches that
// the existing watcher acquires autonomously. State (list snapshots, which
// books we've already handled, and pending digest events) lives in lists.json
// (gitignored, bind-mounted in Docker), same posture as watchlist.json.
//
// Sources are pluggable modules under src/listsources/ (same pattern as
// notify channels): NYT Books API (Phase 1 anchor), plus two scraped Goodreads
// adult-fiction genre pages (Phase 2) — each breaks independently. Lists
// refresh weekly-ish, so the diff is what makes the schedule safe to run daily:
// an unchanged list yields no entrants, no watches, no email.
//
// DEDUPE: the same book appears across sources spelled differently
// ("WHISTLER" on NYT, "Whistler: A Novel" on a scraped list), so identity is
// entryKey = cleaned title + first author's last name. The `seen` map keyed
// this way guarantees a book is processed once, ever, across all sources.

const fs = require('fs');
const path = require('path');

const util = require('./listsources/util');
const nyt = require('./listsources/nyt');
const goodreads = require('./listsources/goodreads');

const FILE = path.join(__dirname, '..', 'lists.json');

// A list book that never appears on Mobilism shouldn't be watched forever.
const LIST_WATCH_MAX_AGE_MS = Number(process.env.LIST_WATCH_MAX_AGE_MS) || 56 * 24 * 3600 * 1000; // 8 weeks

// Tags stamped onto auto-acquired books so the Library's tag chips group them.
const LIST_TAGS = ['New release'];

// One-time Goodreads "Most Read" backfill (issue #33 follow-up): the live
// radar only ever watches NEW entrants on a diff, so books already on the
// list before the radar started tracking it are never picked up. These
// constants label backfill-origin watches distinctly (Watchlist/Library/
// digest) from the live radar's own Most Read watches.
const BACKFILL_TAG = 'Backfill';
const BACKFILL_LABEL = 'Goodreads Most Read (Adult Fiction) — backfill';
const BACKFILL_SOURCE_ID = 'goodreads-most-read-adult-fiction';

/** Fresh backfill state (see readState()'s `backfill` key doc below). */
function defaultBackfill() {
  return {
    status: 'idle', // 'idle' | 'running' | 'done'
    queue: [], // [{ title, author }] — remaining, not-yet-resolved entries
    totalCount: 0, // queue size at build time (fixed once running)
    watchedCount: 0, // entries turned into watches so far
    ownedCount: 0, // entries resolved as already-owned at drain time
    startedAt: null,
    finishedAt: null,
  };
}

/** Every registered source, in pull order: { id, label, tag, configured,
 *  priority, fetch }. Sorted by `priority` (lower first) so the per-pull intake
 *  cap is spent on the highest-signal lists first — NYT, then Goodreads New
 *  Releases, then Goodreads Most Read. Stable for equal priorities. */
function sources() {
  return [...nyt.sources(), ...goodreads.sources()]
    .map((s, i) => ({ s, i }))
    .sort((a, b) => ((a.s.priority ?? 50) - (b.s.priority ?? 50)) || (a.i - b.i))
    .map((x) => x.s);
}

function isConfigured() {
  return sources().some((s) => s.configured);
}

// --- pure helpers ------------------------------------------------------------

const { titleCase, cleanTitle, authorLastName, entryKey } = util;

/** PURE: entries in `next` whose key wasn't in the previous snapshot. */
function newEntrants(prevKeys, next) {
  const seen = new Set(prevKeys || []);
  return (next || []).filter((e) => e && !seen.has(entryKey(e)));
}

/** PURE: active list-origin watches older than maxAge — due to expire. */
function expiredListWatches(watches, now, maxAgeMs = LIST_WATCH_MAX_AGE_MS) {
  return (watches || []).filter((w) => {
    if (!w || w.status !== 'active' || w.source !== 'list') return false;
    const created = Date.parse(w.createdAt || '');
    return !Number.isNaN(created) && now - created >= maxAgeMs;
  });
}

/** PURE: current-page entries minus already-owned and already-actively-watched
 *  books, deduped by queryKey. `isOwned(entry)` and `keyOf(entry)` are
 *  injected; `activeKeys` is a Set of queryKey strings for existing ACTIVE
 *  watches (any source). */
function buildBackfillQueue(entries, { isOwned, activeKeys, keyOf }) {
  const seenKeys = new Set();
  const out = [];
  for (const e of entries || []) {
    if (!e || !e.title) continue;
    if (isOwned(e)) continue;
    const key = keyOf(e);
    if (activeKeys.has(key) || seenKeys.has(key)) continue;
    seenKeys.add(key);
    out.push({ title: e.title, author: e.author });
  }
  return out;
}

// --- state -------------------------------------------------------------------
// { v: 2,
//   snapshots: { <sourceId>: { pulledAt, entries: [{title, author}] } },
//   seen: { <entryKey>: { at, list, disposition } },   // handled once, ever
//   pendingEvents: [ { type, title, author, list, url, at } ],
//   lastRunAt }

/** PURE: v1 state (snapshot key arrays "title|author", seen keyed the same)
 *  → v2 (snapshots store entries; keys derive from entryKey so the key scheme
 *  can evolve without a re-baseline flood). */
function migrateState(state) {
  if (!state || state.v >= 2) return state;
  const splitKey = (k) => {
    const i = String(k).lastIndexOf('|');
    return { title: String(k).slice(0, i), author: String(k).slice(i + 1) };
  };
  const snapshots = {};
  for (const [id, snap] of Object.entries(state.snapshots || {})) {
    snapshots[id] = snap && Array.isArray(snap.keys)
      ? { pulledAt: snap.pulledAt, entries: snap.keys.map(splitKey) }
      : snap;
  }
  const seen = {};
  for (const [k, v] of Object.entries(state.seen || {})) {
    seen[entryKey(splitKey(k))] = v;
  }
  return { ...state, v: 2, snapshots, seen };
}

function readState() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return migrateState({ snapshots: {}, seen: {}, pendingEvents: [], lastRunAt: null, backfill: defaultBackfill(), ...data });
    }
  } catch { /* fresh state */ }
  return { v: 2, snapshots: {}, seen: {}, pendingEvents: [], lastRunAt: null, backfill: defaultBackfill() };
}

// Atomic-with-fallback write (atomic rename can fail on Docker bind mounts).
function writeState(state) {
  const data = JSON.stringify(state, null, 2);
  const tmp = FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, FILE);
  } catch {
    fs.writeFileSync(FILE, data, 'utf8');
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/** Append a digest event (read-modify-write; callers are single-process). */
function recordEvent(ev) {
  const state = readState();
  state.pendingEvents.push({ at: new Date().toISOString(), ...ev });
  writeState(state);
}

/** Pull pending digest events and clear them atomically. */
function drainEvents() {
  const state = readState();
  const events = state.pendingEvents || [];
  if (!events.length) return [];
  state.pendingEvents = [];
  writeState(state);
  return events;
}

module.exports = {
  LIST_TAGS,
  LIST_WATCH_MAX_AGE_MS,
  BACKFILL_TAG,
  BACKFILL_LABEL,
  BACKFILL_SOURCE_ID,
  defaultBackfill,
  sources,
  isConfigured,
  readState,
  writeState,
  recordEvent,
  drainEvents,
  // exported for unit tests
  titleCase,
  cleanTitle,
  authorLastName,
  entryKey,
  newEntrants,
  expiredListWatches,
  buildBackfillQueue,
  migrateState,
  normalizeEntry: nyt.normalizeEntry,
  FILE,
};
