'use strict';

// Batch mode primitives: parse a pasted reading list into searchable entries,
// classify each search's outcome, and run a list of async jobs sequentially
// with per-item failure isolation. All pure / dependency-free so they're
// unit-testable; the batch-search endpoint composes them around searcher.search.

// Cap how many books one batch can request — mirrors the input-bounding posture
// elsewhere (recipients MAX_RECIPIENTS, server body slicing) so a huge paste
// can't kick off hundreds of slow scrapes.
const MAX_BATCH = 50;
const FIELD_MAX = 300; // same per-field cap the single search uses

/**
 * Split one line into { title, author }. Accepts, in priority order:
 *   "Title — Author" / "Title – Author" / "Title - Author"  (spaced dash)
 *   "Title, Author"
 *   "Title"                                                  (title only)
 * The dash form is matched first and non-greedily, so it splits on the FIRST
 * spaced dash and a hyphenated title with no surrounding spaces (e.g.
 * "Spider-Man") stays intact as a title-only entry.
 */
function splitTitleAuthor(line) {
  const dash = line.match(/^(.*?)\s+[—–-]\s+(.*)$/);
  if (dash) return { title: dash[1].trim(), author: dash[2].trim() };
  const ci = line.indexOf(',');
  if (ci >= 0) return { title: line.slice(0, ci).trim(), author: line.slice(ci + 1).trim() };
  return { title: line.trim(), author: '' };
}

/**
 * Parse a multi-line paste into bounded { title, author } entries. Blank lines
 * are ignored, fields are length-capped, entries with no title are dropped, and
 * the result is capped at `max` (default MAX_BATCH).
 */
function parseBatchInput(text, { max = MAX_BATCH } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const { title, author } = splitTitleAuthor(line);
    if (!title) continue;
    out.push({ title: title.slice(0, FIELD_MAX), author: (author || '').slice(0, FIELD_MAX) });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Classify one entry's search result set. Pure.
 *   error      → the search threw (carries the message)
 *   not-found  → zero results
 *   found      → exactly one result (an unambiguous best match)
 *   multiple   → several candidates; the caller offers a choice (best = [0])
 */
function classifyBatchOutcome({ results, error } = {}) {
  if (error) return { status: 'error', error: String(error) };
  const n = Array.isArray(results) ? results.length : 0;
  if (n === 0) return { status: 'not-found' };
  if (n === 1) return { status: 'found' };
  return { status: 'multiple' };
}

/**
 * Run `worker(item, index)` over `items` strictly sequentially, ISOLATING
 * failures: a worker that throws is recorded as { ok:false, error } and the run
 * continues to the next item (one bad book never sinks the batch). `onProgress`
 * is notified with { phase:'start'|'ok'|'error', index, total, ... } as it goes.
 *
 * Returns [{ item, ok, value? , error? }] in input order.
 */
async function runSequential(items, worker, onProgress = () => {}) {
  const list = Array.isArray(items) ? items : [];
  const results = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    onProgress({ phase: 'start', index: i + 1, total: list.length, item });
    try {
      const value = await worker(item, i);
      results.push({ item, ok: true, value });
      onProgress({ phase: 'ok', index: i + 1, total: list.length, item, value });
    } catch (err) {
      const error = (err && err.message) || String(err);
      results.push({ item, ok: false, error });
      onProgress({ phase: 'error', index: i + 1, total: list.length, item, error });
    }
  }
  return results;
}

module.exports = {
  MAX_BATCH,
  parseBatchInput,
  splitTitleAuthor,
  classifyBatchOutcome,
  runSequential,
};
