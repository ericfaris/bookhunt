'use strict';

// Amazon new-release charts (issue #33 Phase 2), narrowed to specific
// sub-category browse nodes so the radar's audience doesn't get flooded with
// romance/paranormal titles. Amazon's category tree IS the genre filter: the
// scrape only yields { title, author } (no genre signal to filter on), so
// instead of the broad "Literature & Fiction" node (17) we pull a curated set
// of narrower sub-category nodes — the romance node is simply never fetched.
//
// The node set is configurable via AMAZON_LISTFIC_NODES (comma-separated
// browse-node IDs); unset ⇒ the shipped DEFAULT_NODES below. This stays a
// single merged logical source: it fetches every configured node, merges and
// dedupes the entries (by the same entryKey the cross-source radar uses), and
// proceeds as long as at least one node returned books — erroring only when
// ALL nodes fail or the whole set parses to 0 (a bot page / markup change),
// so one flaky node can never blank the radar nor silently empty a chart.
//
// The parser is PURE (exported for tests against a fixture) and scoped per
// item: each book sits in an `id="p13n-asin-index-N"` container whose first
// two line-clamp spans are the title and the author, so a missing author can
// never misalign the pairing.

const { cleanTitle, cleanAuthor, entryKey, decodeEntities, SCRAPE_HEADERS } = require('./util');

// Verified 2026-07-11 against live Amazon <h1>/<title> (see
// .claude/plans/amazon-genre-filter-plan.md Task 0). Node N's new-release
// chart lives at https://www.amazon.com/gp/new-releases/books/N.
const DEFAULT_NODES = [
  '18',    // Mystery, Thriller & Suspense
  '10132', // Literary Fiction
  '10177', // Historical Fiction
];

// Politeness gap (ms) between node requests. Read at fetch time (not load) so
// AMAZON_NODE_GAP_MS can override it — mainly so tests don't sleep for real.
function nodeGapMs() {
  const n = Number(process.env.AMAZON_NODE_GAP_MS);
  return Number.isFinite(n) && n >= 0 ? n : 2000;
}

/** PURE(env): configured node IDs — AMAZON_LISTFIC_NODES (comma-separated) or
 *  DEFAULT_NODES. Junk tokens (non-digits) are dropped and duplicates removed;
 *  an env var that yields no valid IDs falls back to the defaults (a typo must
 *  not silently disable the source). Read at call time, not module load. */
function nodeIds() {
  const raw = String(process.env.AMAZON_LISTFIC_NODES || '');
  if (!raw.trim()) return DEFAULT_NODES;
  const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s)))];
  if (!ids.length) {
    console.warn(`AMAZON_LISTFIC_NODES="${raw}" has no valid node IDs — using defaults`);
    return DEFAULT_NODES;
  }
  return ids;
}

/** PURE: node id → new-releases chart URL. */
function nodeUrl(id) {
  return `https://www.amazon.com/gp/new-releases/books/${encodeURIComponent(id)}`;
}

/** PURE: chart HTML → [{ title, author }]. */
function parse(html) {
  const items = String(html || '').split(/id="p13n-asin-index-\d+"/).slice(1);
  const out = [];
  for (const item of items) {
    const spans = [...item.matchAll(/p13n-sc-css-line-clamp[^"]*">([^<]+)</g)].map((m) => m[1]);
    if (!spans.length) continue;
    const title = cleanTitle(decodeEntities(spans[0]));
    const author = cleanAuthor(decodeEntities(spans[1] || ''));
    if (title) out.push({ title, author });
  }
  return out;
}

/** PURE: per-node results → merged entries. `results` is
 *  [{ node, entries }|{ node, error }] (exactly one of entries/error set; a
 *  node whose page parsed to 0 books arrives as an error, not entries:[]).
 *  Merges in node order and dedupes by entryKey (first occurrence wins).
 *  Throws when the merged set is empty (all nodes failed or parsed to 0),
 *  with every per-node error in the message. */
function mergeNodeResults(results) {
  const seen = new Set();
  const merged = [];
  for (const r of results || []) {
    for (const e of (r && r.entries) || []) {
      const k = entryKey(e);
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(e);
    }
  }
  if (!merged.length) {
    const errs = (results || [])
      .filter((r) => r && r.error)
      .map((r) => `node ${r.node}: ${r.error}`)
      .join('; ');
    throw new Error(`Amazon chart: all nodes failed or parsed to 0 books — ${errs || 'no nodes configured'}`);
  }
  return merged;
}

async function fetchNode(id) {
  const res = await fetch(nodeUrl(id), { headers: SCRAPE_HEADERS, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Amazon node ${id} responded ${res.status}`);
  const entries = parse(await res.text());
  if (!entries.length) throw new Error(`Amazon node ${id} parsed to 0 books — bot page or markup change`);
  return entries;
}

async function fetchChart() {
  const ids = nodeIds();
  const gap = nodeGapMs();
  const results = [];
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    try {
      results.push({ node: id, entries: await fetchNode(id) });
    } catch (err) {
      console.warn(`Amazon node ${id} fetch failed: ${err.message}`);
      results.push({ node: id, error: err.message });
    }
    if (gap && i < ids.length - 1) await new Promise((r) => setTimeout(r, gap));
  }
  return mergeNodeResults(results);
}

function sources() {
  return [{
    id: 'amazon-new-releases',
    label: 'Amazon New Releases',
    tag: 'Amazon New Releases',
    configured: true,
    fetch: fetchChart,
  }];
}

module.exports = { sources, parse, nodeIds, nodeUrl, mergeNodeResults, DEFAULT_NODES };
