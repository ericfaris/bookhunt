'use strict';

// Persisted app settings (settings.json, gitignored + bind-mounted in Docker).
// Currently just the watchlist re-check cadence, but structured as a small
// key/value store so more user-tunable settings can be added. Pure helpers
// (clampWatchMinutes) are exported for unit testing.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'settings.json');

// Cadence bounds. The default seeds from the env (WATCH_CHECK_INTERVAL_MS) so an
// operator can still set the initial value there; the UI then overrides it.
const MIN_WATCH_MIN = 5; // never tighter than the scheduler tick — be polite to Mobilism
const MAX_WATCH_MIN = 7 * 24 * 60; // a week
const DEFAULT_WATCH_MIN = Math.min(
  MAX_WATCH_MIN,
  Math.max(MIN_WATCH_MIN, Math.round((Number(process.env.WATCH_CHECK_INTERVAL_MS) || 1800000) / 60000))
);

function readAll() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

// Atomic-with-fallback write (atomic rename can fail on Docker bind mounts).
function writeAll(obj) {
  const data = JSON.stringify(obj, null, 2);
  const tmp = FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, FILE);
  } catch {
    fs.writeFileSync(FILE, data, 'utf8');
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/** PURE: clamp arbitrary input to a valid cadence in minutes. */
function clampWatchMinutes(v, fallback = DEFAULT_WATCH_MIN) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_WATCH_MIN, Math.max(MIN_WATCH_MIN, Math.round(n)));
}

function getWatchIntervalMin() {
  return clampWatchMinutes(readAll().watchCheckIntervalMin, DEFAULT_WATCH_MIN);
}

function getWatchIntervalMs() {
  return getWatchIntervalMin() * 60000;
}

function setWatchIntervalMin(v) {
  const minutes = clampWatchMinutes(v);
  const all = readAll();
  all.watchCheckIntervalMin = minutes;
  writeAll(all);
  return minutes;
}

module.exports = {
  getWatchIntervalMin,
  getWatchIntervalMs,
  setWatchIntervalMin,
  // exported for unit tests + UI bounds
  clampWatchMinutes,
  MIN_WATCH_MIN,
  MAX_WATCH_MIN,
  DEFAULT_WATCH_MIN,
};
