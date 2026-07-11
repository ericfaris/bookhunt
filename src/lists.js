'use strict';

// New-release list radar (issue #33): pull fiction bestseller/new-release
// lists on a schedule, diff them against the previous pull, and surface only
// the NEW entrants — the listwatcher turns those into watchlist watches that
// the existing watcher acquires autonomously. State (list snapshots, which
// books we've already handled, and pending digest events) lives in lists.json
// (gitignored, bind-mounted in Docker), same posture as watchlist.json.
//
// Sources are pluggable modules under src/listsources/ (same pattern as
// notify channels): NYT Books API (Phase 1 anchor), plus scraped Amazon and
// Goodreads charts (Phase 2) — each breaks independently. Lists refresh
// weekly-ish, so the diff is what makes the schedule safe to run daily: an
// unchanged list yields no entrants, no watches, no email.
//
// DEDUPE: the same book appears across sources spelled differently
// ("WHISTLER" on NYT, "Whistler: A Novel" on Amazon), so identity is
// entryKey = cleaned title + first author's last name. The `seen` map keyed
// this way guarantees a book is processed once, ever, across all sources.

const fs = require('fs');
const path = require('path');

const util = require('./listsources/util');
const nyt = require('./listsources/nyt');
const amazon = require('./listsources/amazon');
const goodreads = require('./listsources/goodreads');

const FILE = path.join(__dirname, '..', 'lists.json');

// A list book that never appears on Mobilism shouldn't be watched forever.
const LIST_WATCH_MAX_AGE_MS = Number(process.env.LIST_WATCH_MAX_AGE_MS) || 56 * 24 * 3600 * 1000; // 8 weeks

// Tags stamped onto auto-acquired books so the Library's tag chips group them.
const LIST_TAGS = ['New release'];

/** Every registered source, in pull order: { id, label, tag, configured, fetch }. */
function sources() {
  return [...nyt.sources(), ...amazon.sources(), ...goodreads.sources()];
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
      return migrateState({ snapshots: {}, seen: {}, pendingEvents: [], lastRunAt: null, ...data });
    }
  } catch { /* fresh state */ }
  return { v: 2, snapshots: {}, seen: {}, pendingEvents: [], lastRunAt: null };
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
  migrateState,
  normalizeEntry: nyt.normalizeEntry,
  FILE,
};
