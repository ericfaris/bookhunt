'use strict';

// Per-book tags / collections for the Library, persisted to booktags.json
// (gitignored, bind-mounted in Docker). Tags are keyed by the book's resolved
// savePath — the same natural identity the Library uses — so they survive
// re-downloads of the same file.
//
// The cleaning/merging logic is PURE (and exported) so it's unit-testable
// without the filesystem; only readStore/writeStore touch disk.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'booktags.json');

const MAX_TAGS = 25;
const MAX_TAG_LEN = 40;

/** PURE: normalize a list of raw tag strings — trim, drop blanks, cap length,
 *  de-dupe case-insensitively (first spelling wins), cap count. */
function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_LEN);
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Natural key for a book — its resolved file path. */
function keyFor(savePath) {
  return savePath ? path.resolve(savePath) : '';
}

/** PURE: attach a `tags` array to each library book from a {key: tags} store,
 *  and return the merged books. Books with no stored tags get `[]`. */
function attachTags(books, store) {
  const map = store || {};
  return (books || []).map((b) => ({ ...b, tags: map[keyFor(b.savePath)] || [] }));
}

/** PURE: every distinct tag across a {key: tags} store, sorted (case-insensitive). */
function allTags(store) {
  const set = new Map(); // lower -> original
  for (const tags of Object.values(store || {})) {
    for (const t of tags || []) {
      const k = t.toLowerCase();
      if (!set.has(k)) set.set(k, t);
    }
  }
  return [...set.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

// --- Persistence ------------------------------------------------------------
function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function writeStore(store) {
  const data = JSON.stringify(store, null, 2);
  const tmp = FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, FILE);
  } catch {
    fs.writeFileSync(FILE, data, 'utf8');
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/** Set (replace) the tags for one book. Returns the cleaned tags. */
function setTags(savePath, tags) {
  const key = keyFor(savePath);
  if (!key) return [];
  const cleaned = cleanTags(tags);
  const store = readStore();
  if (cleaned.length) store[key] = cleaned;
  else delete store[key];
  writeStore(store);
  return cleaned;
}

module.exports = {
  cleanTags, attachTags, allTags, keyFor,
  readStore, writeStore, setTags,
  FILE,
};
