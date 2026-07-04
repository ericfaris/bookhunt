'use strict';

// New-release list radar (issue #33): pull fiction bestseller lists on a
// schedule, diff them against the previous pull, and surface only the NEW
// entrants — the listwatcher turns those into watchlist watches that the
// existing watcher acquires autonomously. State (list snapshots, which books
// we've already handled, and pending digest events) lives in lists.json
// (gitignored, bind-mounted in Docker), same posture as watchlist.json.
//
// Phase 1 source: the NYT Books API (official, free key via NYT_API_KEY).
// Lists refresh weekly, so the diff is what makes the schedule safe to run
// daily: an unchanged list yields no entrants, no watches, no email.
// The pure helpers (titleCase, normalizeEntry, entryKey, newEntrants,
// expiredListWatches) are exported for unit testing without the network.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'lists.json');

// The fiction lists we follow. `id` is the NYT list name in their URL scheme.
const NYT_LISTS = [
  { id: 'combined-print-and-e-book-fiction', label: 'NYT Combined Print & E-Book Fiction' },
  { id: 'hardcover-fiction', label: 'NYT Hardcover Fiction' },
];

// A list book that never appears on Mobilism shouldn't be watched forever.
const LIST_WATCH_MAX_AGE_MS = Number(process.env.LIST_WATCH_MAX_AGE_MS) || 56 * 24 * 3600 * 1000; // 8 weeks

// Tags stamped onto auto-acquired books so the Library's tag chips group them.
const LIST_TAGS = ['New release'];

function isConfigured() {
  return !!process.env.NYT_API_KEY;
}

// --- pure helpers ------------------------------------------------------------

/** PURE: NYT titles arrive ALL-CAPS ("THEO OF GOLDEN") — title-case them so
 *  searches, emails, and the Library read naturally. Small connector words stay
 *  lowercase mid-title; hyphenated parts are cased per segment. */
const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on', 'or', 'so', 'the', 'to', 'up', 'yet']);
function titleCase(s) {
  const words = String(s || '').trim().toLowerCase().split(/\s+/);
  // Capitalize at word start and after hyphens — NOT after apostrophes, which
  // would mangle possessives ("Hitchhiker'S"). O'Brien-style names lose out,
  // but the search is case-insensitive so only display is affected.
  const cap = (w) => w.replace(/(^|-)(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
  return words
    .map((w, i) => (i > 0 && i < words.length - 1 && SMALL_WORDS.has(w) ? w : cap(w)))
    .join(' ');
}

/** PURE: one NYT book payload → the {title, author} shape the search pipeline
 *  wants. Returns null for junk rows (no title). */
function normalizeEntry(book) {
  const title = titleCase((book && book.title) || '');
  const author = String((book && book.author) || '').trim();
  return title ? { title, author } : null;
}

/** PURE: case-insensitive identity of an entry — same shape as
 *  watchlist.queryKey so dedupe agrees across both stores. */
function entryKey(e) {
  return `${(e.title || '').toLowerCase()}|${(e.author || '').toLowerCase()}`;
}

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
// { snapshots: { <listId>: { pulledAt, keys[] } },
//   seen: { <entryKey>: { at, list, disposition } },   // handled once, ever
//   pendingEvents: [ { type, title, author, list, url, at } ],
//   lastRunAt }

function readState() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return { snapshots: {}, seen: {}, pendingEvents: [], lastRunAt: null, ...data };
    }
  } catch { /* fresh state */ }
  return { snapshots: {}, seen: {}, pendingEvents: [], lastRunAt: null };
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

// --- NYT fetch -----------------------------------------------------------------

async function fetchList(listId) {
  const url = `https://api.nytimes.com/svc/books/v3/lists/current/${encodeURIComponent(listId)}.json?api-key=${encodeURIComponent(process.env.NYT_API_KEY || '')}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`NYT API responded ${res.status} for ${listId}`);
  const data = await res.json();
  const books = (data && data.results && data.results.books) || [];
  return books.map(normalizeEntry).filter(Boolean);
}

module.exports = {
  NYT_LISTS,
  LIST_TAGS,
  LIST_WATCH_MAX_AGE_MS,
  isConfigured,
  fetchList,
  readState,
  writeState,
  recordEvent,
  drainEvents,
  // exported for unit tests
  titleCase,
  normalizeEntry,
  entryKey,
  newEntrants,
  expiredListWatches,
  FILE,
};
