'use strict';

const fs = require('fs');
const path = require('path');

// Overridable so tests can exercise the real read/mutate/write cycle against a
// temp file instead of the live history. Unset in production → the real file.
const HISTORY_FILE = process.env.HISTORY_FILE || path.join(__dirname, '..', 'history.json');

function readAll() {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeAll(entries) {
  const data = JSON.stringify(entries, null, 2);
  const tmp = HISTORY_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, HISTORY_FILE);
  } catch {
    // Atomic rename fails on Docker bind-mounted files (Windows/WSL2 filesystem).
    // Fall back to a direct write — safe enough for a single-process app.
    fs.writeFileSync(HISTORY_FILE, data, 'utf8');
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/**
 * Read-modify-write in ONE synchronous step, against a FRESH read of the file.
 *
 * Never do `const e = readAll(); await something(); writeAll(e);` — the snapshot
 * goes stale across the await and writing it back silently erases every entry
 * appended in that window (a watcher auto-download, a Kindle send, a search).
 * Do the slow work first, then call mutate() with the result.
 *
 * `fn` receives the fresh entries and may mutate them in place, return a
 * replacement array, or return false to abort without writing. Returns the
 * persisted array.
 */
function mutate(fn) {
  const entries = readAll();
  const out = fn(entries);
  if (out === false || out === null) return entries; // nothing to persist
  const next = Array.isArray(out) ? out : entries;
  writeAll(next);
  return next;
}

/**
 * Append an entry and persist. Returns the stored entry (with id + timestamp).
 */
function add(entry) {
  const stored = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    ...entry,
  };
  mutate((entries) => { entries.unshift(stored); });
  return stored;
}

/** Record a search so it can be re-run with one click. */
function logSearch({ title, author, sort, resultCount }) {
  return add({ type: 'search', title, author, sort, resultCount });
}

/** Record a completed download. `author`/`cover` (when known from the search
 *  result) ride along so the Library can show a cover without a fresh lookup.
 *  The title is cleaned at ingest (forum-topic artifacts like "(.ePUB)" /
 *  "… by Author" / leading "- " stripped) so the Library, reader shelf, and
 *  emails never show scraper noise. */
function logDownload({ title, author, filename, savePath, url, mode, verified, size, cover }) {
  const titles = require('./titles');
  const clean = titles.displayTitle({ title, author, filename });
  return add({ type: 'download', title: clean, author, filename, savePath, url, mode, verified, size, cover });
}

/**
 * Record a notification / Kindle push send. `downloadId` ties the send back to
 * the exact download entry it came from, so the Library view can correlate
 * sends to books precisely (older entries without it fall back to filename
 * matching).
 */
function logNotify({ downloadId, title, filename, to, kindlePushed, channels }) {
  return add({ type: 'notify', downloadId, title, filename, to, kindlePushed, channels });
}

module.exports = { readAll, writeAll, mutate, add, logSearch, logDownload, logNotify };
