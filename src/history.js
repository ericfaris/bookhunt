'use strict';

const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, '..', 'history.json');

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
 * Append an entry and persist. Returns the stored entry (with id + timestamp).
 */
function add(entry) {
  const entries = readAll();
  const stored = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    ...entry,
  };
  entries.unshift(stored);
  writeAll(entries);
  return stored;
}

/** Record a search so it can be re-run with one click. */
function logSearch({ title, author, sort, resultCount }) {
  return add({ type: 'search', title, author, sort, resultCount });
}

/** Record a completed download. */
function logDownload({ title, filename, savePath, url, mode, verified, size }) {
  return add({ type: 'download', title, filename, savePath, url, mode, verified, size });
}

/** Record a notification / Kindle push send. */
function logNotify({ title, filename, to, kindlePushed, channels }) {
  return add({ type: 'notify', title, filename, to, kindlePushed, channels });
}

module.exports = { readAll, add, logSearch, logDownload, logNotify };
