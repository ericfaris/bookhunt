'use strict';

// Persistent watchlist (issue #7): saved searches the server re-runs on a
// schedule, notifying the user when a match finally appears. Stored in
// watchlist.json (gitignored, bind-mounted in Docker), same posture as
// recipients.json. The pure helpers (cleanWatchInput, dueWatches) are exported
// for unit testing without a scheduler.
//
// Watch shape:
//   { id, title, author, sort, recipientIds[], status, createdAt,
//     lastCheckedAt, checkCount, lastError, foundUrl, foundAt,
//     downloadMisses, retryAfter }
//   status: 'active' | 'paused' | 'fulfilled' | 'expired'
// An ACTIVE watch with downloadMisses > 0 was found but didn't download; it is
// not due again until retryAfter (the watcher's backoff).
// A watch whose acquisition is verified AND positively title-matched is removed
// outright by the watcher (src/watcher.js checkWatch) — 'fulfilled' persists only
// for weaker matches (e.g. titleMatch null / notify-only).

const path = require('path');
const datastore = require('./datastore');

const FILE = process.env.WATCHLIST_FILE || path.join(__dirname, '..', 'watchlist.json');
const MAX_LEN = 300;
const MAX_WATCHES = 200;

function clean(s) {
  return typeof s === 'string' ? s.trim().slice(0, MAX_LEN) : '';
}

// Hardened file I/O (tmp-copy recovery, bind-mount-safe in-place fallback)
// lives in src/datastore.js, shared by every JSON store; the Atlas mirror too.
const store = datastore.defineStore('watchlist', { file: FILE, shape: 'array' });
const readJsonList = (file) => datastore.readJsonFile(file, 'array');
const writeJsonList = (file, list) => { datastore.writeJsonFile(file, list); };

function readAll() {
  return store.read();
}

function writeAll(list) {
  store.write(list);
}

/** PURE: validate + normalize new-watch input. Throws on bad input. */
function cleanWatchInput({ title, author, sort, recipientIds } = {}) {
  const t = clean(title);
  const a = clean(author);
  if (!t && !a) throw new Error('Enter a title and/or an author to watch');
  const s = sort === 'oldest' ? 'oldest' : 'newest';
  const ids = Array.isArray(recipientIds)
    ? [...new Set(recipientIds.filter((x) => typeof x === 'string' && x))].slice(0, 500)
    : [];
  return { title: t, author: a, sort: s, recipientIds: ids };
}

// Case-insensitive identity of a watch's query, for de-duping.
function queryKey(w) {
  return `${(w.title || '').toLowerCase()}|${(w.author || '').toLowerCase()}`;
}

function add(input) {
  const cleaned = cleanWatchInput(input);
  const list = readAll();
  // Re-use an existing ACTIVE watch for the same query rather than duplicating.
  const existing = list.find((w) => w.status === 'active' && queryKey(w) === queryKey(cleaned));
  if (existing) return existing;
  if (list.length >= MAX_WATCHES) throw new Error('Too many watches');
  const entry = {
    id: 'w_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ...cleaned,
    status: 'active',
    createdAt: new Date().toISOString(),
    lastCheckedAt: null,
    checkCount: 0,
    lastError: null,
    foundUrl: null,
    foundAt: null,
  };
  list.push(entry);
  writeAll(list);
  return entry;
}

function remove(id) {
  const list = readAll();
  const next = list.filter((w) => w.id !== id);
  writeAll(next);
  return next.length !== list.length;
}

function update(id, patch) {
  const list = readAll();
  let updated = null;
  for (const w of list) {
    if (w.id === id) {
      Object.assign(w, patch);
      updated = w;
    }
  }
  if (updated) writeAll(list);
  return updated;
}

// PURE: normalize a recipientIds array (de-dupe, strings only, capped).
function cleanRecipientIds(recipientIds) {
  return Array.isArray(recipientIds)
    ? [...new Set(recipientIds.filter((x) => typeof x === 'string' && x))].slice(0, 500)
    : [];
}

function setRecipients(id, recipientIds) {
  return update(id, { recipientIds: cleanRecipientIds(recipientIds) });
}

function setStatus(id, status) {
  if (!['active', 'paused', 'fulfilled', 'expired'].includes(status)) throw new Error('Invalid status');
  // Re-activating a fulfilled/paused/expired watch clears the previous
  // "found" state and no-match count so it gets a fresh run (otherwise a
  // watch reactivated from 'expired' would hit the 20-check cap again on its
  // very next check). resumedAt restarts the radar's 8-week age clock
  // (lists.expiredListWatches), which otherwise re-expires an old resumed
  // list watch on the next daily run, before it is ever re-checked.
  const patch = status === 'active'
    ? { status, foundUrl: null, foundAt: null, lastError: null, checkCount: 0, downloadMisses: 0, retryAfter: null, resumedAt: new Date().toISOString() }
    : { status };
  return update(id, patch);
}

/**
 * PURE: which active watches are due for a re-check now (least-recently-checked
 * first). A never-checked watch (lastCheckedAt = null) is always due; one
 * backing off after a failed download waits for its retryAfter too.
 */
function dueWatches(watches, now, intervalMs) {
  const at = (w) => {
    const t = w.lastCheckedAt ? Date.parse(w.lastCheckedAt) : 0;
    return Number.isNaN(t) ? 0 : t;
  };
  const backingOff = (w) => {
    const t = w.retryAfter ? Date.parse(w.retryAfter) : NaN;
    return !Number.isNaN(t) && now < t;
  };
  return (watches || [])
    .filter((w) => w && w.status === 'active')
    .filter((w) => now - at(w) >= intervalMs)
    .filter((w) => !backingOff(w))
    .sort((x, y) => at(x) - at(y));
}

/**
 * PURE: dueWatches, but list-origin watches (the new-release radar's) never
 * re-check faster than `listFloorMs` no matter how tight the user's watchlist
 * cadence is. Bestseller lists refresh weekly; a hand-added watch cadence of
 * 15 minutes shouldn't multiply across dozens of accumulated list watches into
 * a forum hammering. Merged result stays least-recently-checked first.
 */
function dueWatchesMixed(watches, now, intervalMs, listFloorMs) {
  const all = watches || [];
  const hand = dueWatches(all.filter((w) => w && w.source !== 'list'), now, intervalMs);
  const listed = dueWatches(all.filter((w) => w && w.source === 'list'), now, Math.max(intervalMs, listFloorMs));
  const at = (w) => {
    const t = w.lastCheckedAt ? Date.parse(w.lastCheckedAt) : 0;
    return Number.isNaN(t) ? 0 : t;
  };
  return [...hand, ...listed].sort((x, y) => at(x) - at(y));
}

module.exports = {
  readAll,
  add,
  remove,
  update,
  setStatus,
  setRecipients,
  // exported for unit tests
  readJsonList,
  writeJsonList,
  cleanWatchInput,
  cleanRecipientIds,
  dueWatches,
  dueWatchesMixed,
  queryKey,
};
