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
// A watch whose acquisition is verified AND positively title-matched is removed
// outright by the watcher (src/watcher.js checkWatch) — 'fulfilled' persists only
// for weaker matches (e.g. titleMatch null / notify-only).

const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = path.join(__dirname, '..', 'watchlist.json');
const MAX_LEN = 300;
const MAX_WATCHES = 200;

function clean(s) {
  return typeof s === 'string' ? s.trim().slice(0, MAX_LEN) : '';
}

// The tmp copy lives in the OS temp dir, not beside the target. /app is
// root-owned in production (only the bind-mounted files themselves are
// writable by the uid-1000 process, not new files in that directory), so a
// tmp file created next to the target would fail with EACCES before we ever
// got to the rename/fallback logic. os.tmpdir() (e.g. /tmp) is world-writable
// in the container, so the tmp copy — and therefore the crash-recovery
// guarantee below — can always be created.
function tmpPathFor(file) {
  return path.join(os.tmpdir(), path.basename(file) + '.tmp');
}

// Hardened read with recovery. A missing file returns [] (first run). But a file
// that EXISTS yet fails to parse is treated as a possibly-interrupted write: we
// try the tmp copy (written to os.tmpdir(), see tmpPathFor — a verified copy
// writeJsonList leaves behind on any fallback-write interruption), restore it in
// place if it parses to an array, and only then fall back to [] — so a
// half-written target no longer silently empties the whole watchlist.
function readJsonList(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return []; // ENOENT etc. — genuinely no file yet.
  }
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    // File exists but is corrupt — try to recover from the tmp copy.
    try {
      const tmp = JSON.parse(fs.readFileSync(tmpPathFor(file), 'utf8'));
      if (Array.isArray(tmp)) {
        fs.writeFileSync(file, JSON.stringify(tmp, null, 2), 'utf8');
        return tmp;
      }
    } catch {}
    return [];
  }
}

// Hardened write. Atomic rename can fail on Docker bind mounts (the live
// watchlist.json is a single-file bind mount, so renameSync onto it throws
// EXDEV — cross-device link). We therefore write+verify a tmp copy first (in
// os.tmpdir(), see tmpPathFor — creating a new file in /app itself would throw
// EACCES in production before we ever reached the rename), try the atomic
// rename, and on ANY failure along the way (creating the tmp copy, verifying
// it, or the rename itself) fall back to an in-place writeFileSync + read-back
// verification, only unlinking the verified tmp copy once the target is
// confirmed good. If the fallback write or its verification throws, the tmp
// file is deliberately left behind as a recovery copy (readJsonList restores
// it). Never replace the file via rename in production: swapping the inode
// desyncs the single-file bind mount (same gotcha as lists.json).
function writeJsonList(file, list) {
  const data = JSON.stringify(list, null, 2);
  const tmp = tmpPathFor(file);
  try {
    // Write the tmp copy and verify it parses to a same-length string before we
    // touch the target, guarding against a partial tmp write.
    fs.writeFileSync(tmp, data, 'utf8');
    const tmpBack = fs.readFileSync(tmp, 'utf8');
    JSON.parse(tmpBack);
    if (tmpBack.length !== data.length) throw new Error('watchlist tmp write verification failed');
    fs.renameSync(tmp, file); // atomic fast path (local dev / tests, same device as tmp)
    return;
  } catch {
    // Couldn't create/verify the tmp copy, or the rename failed (EXDEV on the
    // bind mount, or anything else): in-place fallback, verified, directly on
    // the target file — writable because it's an existing bind-mounted file
    // this process owns, unlike creating a new file in a root-owned directory.
  }
  fs.writeFileSync(file, data, 'utf8');
  const back = fs.readFileSync(file, 'utf8');
  JSON.parse(back); // throws → surfaces as an error
  if (back.length !== data.length) throw new Error('watchlist write verification failed');
  try { fs.unlinkSync(tmp); } catch {} // best-effort; may not exist if the tmp write itself failed
}

function readAll() {
  return readJsonList(FILE);
}

function writeAll(list) {
  writeJsonList(FILE, list);
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
  readJsonList,
  writeJsonList,
  cleanWatchInput,
  cleanRecipientIds,
  dueWatches,
  dueWatchesMixed,
  queryKey,
};
