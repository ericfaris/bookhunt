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

// --- New-release list radar (issue #33) --------------------------------------
// Enabled by default once NYT_API_KEY is set; the UI toggle overrides. Pull
// cadence is generous by default (daily) — the lists themselves refresh weekly.
const MIN_LIST_HOURS = 1;
const MAX_LIST_HOURS = 7 * 24;
const DEFAULT_LIST_HOURS = 24;

/** PURE: clamp arbitrary input to a valid pull cadence in hours. */
function clampListHours(v, fallback = DEFAULT_LIST_HOURS) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_LIST_HOURS, Math.max(MIN_LIST_HOURS, Math.round(n)));
}

function getListsEnabled() {
  const v = readAll().listsEnabled;
  return v === undefined ? true : !!v;
}

function setListsEnabled(v) {
  const all = readAll();
  all.listsEnabled = !!v;
  writeAll(all);
  return all.listsEnabled;
}

function getListPullIntervalHours() {
  return clampListHours(readAll().listPullIntervalHours, DEFAULT_LIST_HOURS);
}

function getListPullIntervalMs() {
  return getListPullIntervalHours() * 3600000;
}

function setListPullIntervalHours(v) {
  const hours = clampListHours(v);
  const all = readAll();
  all.listPullIntervalHours = hours;
  writeAll(all);
  return hours;
}

module.exports = {
  getWatchIntervalMin,
  getWatchIntervalMs,
  setWatchIntervalMin,
  getListsEnabled,
  setListsEnabled,
  getListPullIntervalHours,
  getListPullIntervalMs,
  setListPullIntervalHours,
  // exported for unit tests + UI bounds
  clampWatchMinutes,
  clampListHours,
  MIN_WATCH_MIN,
  MAX_WATCH_MIN,
  DEFAULT_WATCH_MIN,
  MIN_LIST_HOURS,
  MAX_LIST_HOURS,
  DEFAULT_LIST_HOURS,
};
