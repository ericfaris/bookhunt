'use strict';

// Persistent watchlist (issue #7): saved searches the server re-runs on a
// schedule, notifying the user when a match finally appears. Stored in
// watchlist.json (gitignored, bind-mounted in Docker), same posture as
// recipients.json. The pure helpers (cleanWatchInput, dueWatches) are exported
// for unit testing without a scheduler.
//
// Watch shape:
//   { id, title, author, sort, recipientIds[], status, createdAt,
//     lastCheckedAt, checkCount, lastError, foundUrl, foundAt }
//   status: 'active' | 'paused' | 'fulfilled'

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'watchlist.json');
const MAX_LEN = 300;
const MAX_WATCHES = 200;

function clean(s) {
  return typeof s === 'string' ? s.trim().slice(0, MAX_LEN) : '';
}

function readAll() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// Atomic-with-fallback write (atomic rename can fail on Docker bind mounts).
function writeAll(list) {
  const data = JSON.stringify(list, null, 2);
  const tmp = FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, FILE);
  } catch {
    fs.writeFileSync(FILE, data, 'utf8');
    try { fs.unlinkSync(tmp); } catch {}
  }
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
  if (!['active', 'paused', 'fulfilled'].includes(status)) throw new Error('Invalid status');
  // Re-activating a fulfilled/paused watch clears the previous "found" state so
  // it can fire again.
  const patch = status === 'active' ? { status, foundUrl: null, foundAt: null, lastError: null } : { status };
  return update(id, patch);
}

/**
 * PURE: which active watches are due for a re-check now (least-recently-checked
 * first). A never-checked watch (lastCheckedAt = null) is always due.
 */
function dueWatches(watches, now, intervalMs) {
  const at = (w) => {
    const t = w.lastCheckedAt ? Date.parse(w.lastCheckedAt) : 0;
    return Number.isNaN(t) ? 0 : t;
  };
  return (watches || [])
    .filter((w) => w && w.status === 'active')
    .filter((w) => now - at(w) >= intervalMs)
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
  cleanWatchInput,
  cleanRecipientIds,
  dueWatches,
  dueWatchesMixed,
  queryKey,
};
