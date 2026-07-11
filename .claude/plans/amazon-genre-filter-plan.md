# Implementation plan — Amazon new-release radar genre filtering

> Executor context: you are implementing the concept brief at
> `.claude/plans/amazon-genre-filter-brief.md` in the repo
> `/home/eric/projects/bookhunt`. All user decisions are already made and
> recorded below — do **not** re-open them. Read this plan fully before
> touching code.

## Summary

The new-release radar's Amazon source (`src/listsources/amazon.js`) currently
scrapes the single broad "New Releases in Literature & Fiction" node
(`/gp/new-releases/books/17`), which floods the radar with romance/paranormal
titles the user doesn't want. Replace that single hardcoded URL with a curated
set of narrower Amazon sub-category new-release nodes — default: **Mystery,
Thriller & Suspense**, **Literary Fiction**, and **Historical Fiction** —
overridable via a new env var `AMAZON_LISTFIC_NODES` (comma-separated node
IDs). The source stays a *single merged* logical source: it fetches every
configured node, merges and dedupes the entries, proceeds when at least one
node yields books, and errors only when **all** nodes fail or the whole set
parses to 0 books. The parser stays PURE and fixture-testable; the merge and
env parsing are new PURE exports with tests in `test/lists.test.js`. NYT and
Goodreads sources are untouched.

## Approach & key decisions (settled — do not revisit)

1. **Mechanism: narrower nodes, not filtering.** Amazon's category tree *is*
   the genre signal; the scrape returns only `{ title, author }` so there is
   nothing downstream to filter on. The romance node is simply never fetched.
2. **Single merged Amazon source.** `sources()` keeps returning exactly one
   source object that internally fetches all configured nodes and merges.
   Rationale: keeps one digest tag (`Amazon New Releases`), one snapshot to
   diff, and the cross-node dedupe already exists (`lists.entryKey`).
   One-source-per-node was explicitly rejected.
3. **Config: env var, defaults in code.** `AMAZON_LISTFIC_NODES` =
   comma-separated Amazon browse-node IDs. Unset ⇒ the shipped three-node
   default. No settings-UI work. Matches how the whole app is configured
   (see `.env.example`).
4. **Aggregate failure policy: proceed with successes.** A node that 503s or
   parses to 0 books is logged and skipped; the pull succeeds as long as at
   least one node returned ≥1 book. The fetch throws only when the *merged*
   result is empty (all nodes failed / all parsed to 0). This preserves the
   existing "0 books = bot page or markup change, surface an error, never a
   silently-empty chart" guard without letting one flaky node blank the
   radar. The throw message must include the per-node errors.
5. **New source `id` ⇒ silent re-baseline.** Change the source id from
   `amazon-new-releases-lit-fic` to `amazon-new-releases`. Rationale: the
   listwatcher (`src/listwatcher.js` `run()`) diffs each pull against the
   snapshot stored under the source id. Keeping the old id would diff the new
   three-node content against the old node-17 snapshot and treat every
   not-previously-seen book as a "new entrant" — a one-time flood of watches.
   A fresh id makes the first pull a baseline-only seed (the existing
   `if (!prev) summary.seeded.push(...)` branch), which is silent by design.
   The orphaned `amazon-new-releases-lit-fic` snapshot left in `lists.json`
   is harmless; the `seen` map is keyed by book, not source, so nothing
   already handled gets re-watched.

## Prerequisite reading (files you will touch or must understand)

- `src/listsources/amazon.js` — the module to refactor (currently 48 lines;
  `URL` const, PURE `parse(html)`, `fetchChart()`, `sources()`).
- `src/listsources/util.js` — shared PURE helpers (`cleanTitle`,
  `cleanAuthor`, `authorLastName`, `decodeEntities`, `SCRAPE_HEADERS`).
- `src/lists.js` — source registry (`sources()` spreads
  `amazon.sources()`), `entryKey(e)` dedupe key (lines ~53–62), state
  read/write.
- `src/listwatcher.js` — `run()` consumes `source.fetch()`; per-source
  errors are caught and recorded in `summary.errors`; snapshots keyed by
  `source.id`. **No change needed here** — verify that stays true.
- `test/lists.test.js` — the list-source test file; the Amazon fixture tests
  are at lines ~114–133 ("amazon.parse: per-item scoping…", "amazon.parse: a
  bot page…"). Mirror this pattern: inline HTML fixtures built with a small
  `item(i, title, author)` helper, pure-function assertions, no network.
- `.env.example` — the radar env section is at the bottom ("New-release list
  radar (issue #33)", around line 73–77, `# NYT_API_KEY=`).

## Step-by-step tasks (in order)

### Task 0 — Verify the Amazon browse-node IDs (do this FIRST)

Amazon 503s plain server-side fetches (bot-block), so the real browse-node
numbers for the three default sub-categories could **not** be confirmed
during discovery. You must confirm each number before hardcoding it.

**Candidates to verify — do NOT trust them blindly:**

| Category | Candidate node |
|---|---|
| Literature & Fiction (current broad node — known good) | `17` |
| Mystery, Thriller & Suspense | `≈18` |
| Literary Fiction | `≈17061` |
| Historical Fiction | `≈10177` |

**Verification procedure (try in this order):**

1. **Plain fetch with the app's own headers.** Write a throwaway script in
   the scratchpad (NOT in the repo) that does exactly what `fetchChart` does:

   ```js
   const { SCRAPE_HEADERS } = require('/home/eric/projects/bookhunt/src/listsources/util');
   const { parse } = require('/home/eric/projects/bookhunt/src/listsources/amazon');
   const res = await fetch(`https://www.amazon.com/gp/new-releases/books/${node}`,
     { headers: SCRAPE_HEADERS, signal: AbortSignal.timeout(30000) });
   // print: res.status, the <title>…</title> text, any <h1>…</h1>, and parse(html).length
   ```

   A node **passes** when the page `<title>` or `<h1>` names the exact
   sub-category (e.g. "New Releases in Mystery, Thriller & Suspense") **and**
   `parse(html)` returns > 0 books. Sleep 2–3s between node fetches.
2. **If that 503s: harvest the IDs from the known-good node-17 page.** The
   node-17 new-releases page's left sidebar links its sub-categories as
   `/gp/new-releases/books/<id>` anchors with the category name as anchor
   text. One successful fetch of node 17 (which the production app fetches
   daily, so it is known to work from a browser-presenting client) gives an
   authoritative name→id mapping — grep the HTML for
   `gp/new-releases/books/(\d+)[^>]*>([^<]+)`.
3. **If plain fetches 503 from this machine entirely: use a real browser.**
   The `webapp-testing` skill (Playwright) can load
   `https://www.amazon.com/gp/new-releases/books/<id>` headed/headless and
   read the `h1`/`title`. Alternatively the app's own Docker headed-Chromium
   environment. Confirm the heading names the right sub-category.
4. **Fallback if a node cannot be verified:** drop it from the shipped
   default (ship only the verified subset) and leave a code comment with the
   unverified candidate, e.g.
   `// Historical Fiction candidate 10177 — unverified, add via AMAZON_LISTFIC_NODES once confirmed`.
   If **none** of the three verify, keep `['17']` as the sole default so
   behavior degrades to the status quo, and say so prominently in your final
   report. Never hardcode an unverified number as a default.

Record the verified id→name mapping; you need it for the code comment and
`.env.example` docs in later tasks.

### Task 1 — Move `entryKey` into `src/listsources/util.js`

The merged Amazon source must dedupe cross-node duplicates with the **same
key** the rest of the radar uses, but `amazon.js` cannot require `lists.js`
(`lists.js` requires `amazon.js` at the top — circular). `entryKey` is built
entirely from `cleanTitle` + `authorLastName`, which already live in
`util.js`, so move it there:

- **`src/listsources/util.js`**: add the `entryKey(e)` function — copy it
  verbatim from `src/lists.js` (lines ~53–62, including its doc comment) and
  add `entryKey` to `module.exports`.
- **`src/lists.js`**: delete the local definition; destructure it from
  `util` alongside the existing
  `const { titleCase, cleanTitle, authorLastName } = util;` and keep
  `entryKey` in `module.exports` exactly as before (it is consumed by
  `listwatcher.js` and `test/lists.test.js` via `require('../src/lists')` —
  neither may need edits).
- Run `npm test` now — everything must still pass before you touch amazon.js.

### Task 2 — Refactor `src/listsources/amazon.js` to multi-node

Rewrite the module (keep `parse` byte-for-byte identical — it is per-page and
already correct). Target shape:

```js
const { cleanTitle, cleanAuthor, decodeEntities, entryKey, SCRAPE_HEADERS } = require('./util');

// Verified <date> — see .claude/plans/amazon-genre-filter-plan.md Task 0.
const DEFAULT_NODES = [
  '<verified-id>', // Mystery, Thriller & Suspense
  '<verified-id>', // Literary Fiction
  '<verified-id>', // Historical Fiction
];

const NODE_FETCH_GAP_MS = 2000; // politeness between node requests

/** PURE(env): configured node IDs — AMAZON_LISTFIC_NODES (comma-separated)
 *  or the shipped defaults. Junk tokens are dropped; an env var with no
 *  valid IDs falls back to the defaults (with a console.warn). */
function nodeIds() { ... }

/** PURE: node id → chart URL. */
function nodeUrl(id) {
  return `https://www.amazon.com/gp/new-releases/books/${encodeURIComponent(id)}`;
}

/** PURE: chart HTML → [{ title, author }]. */  // UNCHANGED
function parse(html) { ... }

/** PURE: per-node results → merged entries.
 *  results: [{ node, entries, error }] — exactly one of entries/error set;
 *  a node whose page parsed to 0 books arrives as an error, not entries:[].
 *  Merges in node order, dedupes by entryKey (first occurrence wins).
 *  Throws when the merged set is empty (all nodes failed or parsed to 0),
 *  with every per-node error in the message. */
function mergeNodeResults(results) { ... }

async function fetchNode(id) {
  const res = await fetch(nodeUrl(id), { headers: SCRAPE_HEADERS, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Amazon node ${id} responded ${res.status}`);
  const entries = parse(await res.text());
  if (!entries.length) throw new Error(`Amazon node ${id} parsed to 0 books — bot page or markup change`);
  return entries;
}

async function fetchChart() {
  // Sequential (politeness), collecting {node, entries|error} per node;
  // console.warn each per-node failure; sleep NODE_FETCH_GAP_MS between
  // nodes; return mergeNodeResults(results).
}

function sources() {
  return [{
    id: 'amazon-new-releases',            // NEW id — see decision 5
    label: 'Amazon New Releases',
    tag: 'Amazon New Releases',           // unchanged
    configured: true,
    fetch: fetchChart,
  }];
}

module.exports = { sources, parse, nodeIds, nodeUrl, mergeNodeResults, DEFAULT_NODES };
```

Specifics:

- **`nodeIds()`**: split `process.env.AMAZON_LISTFIC_NODES || ''` on commas,
  trim, keep only tokens matching `/^\d+$/`, dedupe. If the env var is unset
  or empty ⇒ `DEFAULT_NODES`. If it is set but yields no valid tokens ⇒
  `console.warn` once and return `DEFAULT_NODES` (a typo must not silently
  disable the source). Read the env var at call time (inside the function),
  not at module load — the tests set/unset it per test.
- **`mergeNodeResults(results)`** is the aggregate-failure policy, PURE and
  directly tested: dedupe with a `Set` of `entryKey(entry)`; empty merged
  output ⇒ `throw new Error('Amazon chart: all nodes failed or parsed to 0 books — ' + <joined per-node errors>)`.
  Partial failure (some errors, some entries) returns the merged entries —
  the warns already happened in `fetchChart`.
- **`fetchChart`** must never let one node's rejection escape before the
  other nodes run — wrap each `fetchNode` in try/catch, push
  `{ node, error: err.message }`, continue.
- Remove the old `URL` export (nothing else in `src/` imports it — confirm
  with `grep -rn "listsources/amazon" src/ test/`); update the module's
  header comment to describe the multi-node design and name the env var.
- Delete the old single-URL const and the old `fetchChart` body it replaced.

### Task 3 — Confirm no changes needed in `src/lists.js` / `src/listwatcher.js`

Beyond the Task 1 `entryKey` relocation, `lists.js` needs nothing: its
`sources()` just spreads `amazon.sources()`, and the shape
(`{ id, label, tag, configured, fetch }`) is unchanged. `listwatcher.js`
needs nothing: it catches `source.fetch()` errors per source
(`summary.errors`) and keys snapshots by `source.id` (the new id triggers the
existing silent baseline path). Read both files and verify; do not edit them
otherwise.

### Task 4 — Tests (`test/lists.test.js`)

Extend the existing "source parsers (fixtures)" section, mirroring its style
(inline HTML fixtures via a small `item()` helper, pure assertions, no
network, `node:test` + `assert`). The two existing amazon tests
(`amazon.parse: per-item scoping…`, `amazon.parse: a bot page…`) still pass
unchanged — `parse` didn't change. Add:

1. **`amazon.nodeIds: defaults when env unset`** — delete
   `process.env.AMAZON_LISTFIC_NODES`, assert `nodeIds()` deep-equals
   `DEFAULT_NODES` and has length 3 (or the verified-subset length).
2. **`amazon.nodeIds: env override, junk tokens dropped`** — set the env var
   to e.g. `' 17061 ,18,,banana,10177 '`, assert
   `['17061','18','10177']`; set it to `'banana'`, assert fallback to
   `DEFAULT_NODES`. Restore/delete the env var in a `finally` (or use
   `t.after`) so test order can't leak state.
3. **`amazon.nodeUrl: builds the new-releases URL from a node id`** —
   `nodeUrl('18')` === `'https://www.amazon.com/gp/new-releases/books/18'`.
4. **`amazon.mergeNodeResults: merges multiple nodes and dedupes cross-node
   duplicates`** — note that entries arriving at the merge are already
   `parse()` output, i.e. already `cleanTitle`d, so build the fixtures as
   post-parse shapes: node A
   `[{ title: 'Whistler', author: 'Ann Patchett' }, { title: 'Book A', author: 'X' }]`,
   node B `[{ title: 'WHISTLER', author: 'Patchett, Ann' }, { title: 'Book B', author: 'Y' }]`.
   Assert merged length 3 and the first-seen spelling
   (`'Whistler'`/`'Ann Patchett'`) survives. This proves acceptance
   criterion 3's dedupe clause via the same `entryKey` the radar uses.
5. **`amazon.mergeNodeResults: one failing node does not zero out the
   others`** — results = one `{ node: '18', error: '503' }` + one success
   with 2 entries ⇒ returns the 2 entries, does not throw.
6. **`amazon.mergeNodeResults: throws when ALL nodes fail`** — all-error
   results ⇒ `assert.throws(..., /all nodes failed/)` and the message
   includes each node's error text.
7. **`amazon.fetchChart` wiring (recommended)** — temporarily replace
   `global.fetch` (save/restore in try/finally) with a stub that 503s node
   one and returns a minimal valid chart page (reuse the `item()` fixture
   helper) for the others, with `AMAZON_LISTFIC_NODES` set to two fake ids;
   assert `fetchChart()` resolves to the parsed entries. Then an all-503
   stub ⇒ rejects. This proves the fetch loop actually implements the merge
   policy. If `NODE_FETCH_GAP_MS` makes this slow, gate the sleep on
   `results.length` (no sleep after the last node) and keep the stubbed test
   to two nodes (~2s) or read the gap from an overridable module constant —
   your call, but the suite must stay fast.
8. **Source-shape regression** — assert `amazon.sources()` returns exactly
   one source with `id === 'amazon-new-releases'`,
   `tag === 'Amazon New Releases'`, `configured === true`, and a `fetch`
   function. Also assert `nyt.sources()` and `goodreads.sources()` shapes
   are untouched only if you changed anything near them (you shouldn't have
   — criterion 5 is satisfied by not editing those files; `git diff` proves
   it).

Also verify the existing `entryKey` tests still pass after the Task 1 move
(they import from `../src/lists`, which re-exports it — no test edits needed
for that).

### Task 5 — Documentation

- **`.env.example`** — in the existing "New-release list radar (issue #33)"
  section (bottom of the file, next to `# NYT_API_KEY=`), add:

  ```
  # Amazon chart: which browse-node new-release lists to pull, comma-separated.
  # Default: <id1> (Mystery, Thriller & Suspense), <id2> (Literary Fiction),
  # <id3> (Historical Fiction). Node N's chart lives at
  # https://www.amazon.com/gp/new-releases/books/N — the category tree is the
  # genre filter, so romance/paranormal nodes are simply never fetched.
  # AMAZON_LISTFIC_NODES=
  ```

  (with the verified ids from Task 0).
- **`README.md`** — the README does not currently document any radar env
  vars (grep for `radar` / `NYT_API_KEY` finds nothing), so `.env.example`
  is this project's env documentation and satisfies acceptance criterion 6.
  Do not invent a new README section.

### Task 6 — Verification pass

1. `cd /home/eric/projects/bookhunt && npm test` — full suite green
   (`node --test test/*.test.js`).
2. `git diff --stat` — confirm `src/listsources/nyt.js` and
   `src/listsources/goodreads.js` are untouched (criterion 5), and
   `src/listwatcher.js` is untouched.
3. Live smoke (best-effort — may 503 from this machine, that's the known
   bot-block, not a bug):
   `node -e "require('/home/eric/projects/bookhunt/src/listsources/amazon').sources()[0].fetch().then(e => console.log(e.length, e.slice(0,5))).catch(e => console.error('EXPECTED-IF-BOT-BLOCKED:', e.message))"`
   If it succeeds, spot-check the first few titles look like the wanted
   genres (no obvious romance/vampire titles).
4. Env override smoke:
   `AMAZON_LISTFIC_NODES=17 node -e "console.log(require('/home/eric/projects/bookhunt/src/listsources/amazon').nodeIds())"`
   prints `['17']`; unset prints the defaults.
5. Do **not** run `npm run docker:up` or restart the production container —
   deployment is the operator's call (memory: rebuilds go through
   `npm run docker:up`, and this app is not devctl-managed).

### Acceptance-criteria → proof map

| Criterion | Proven by |
|---|---|
| 1. Defaults pull the three sub-category nodes, not broad node-17 | Task 0 verified ids in `DEFAULT_NODES`; `nodeIds()` default test; node-17 URL no longer present (grep `books/17` in `src/`) |
| 2. Env-var override, documented | `nodeIds()` override test; `.env.example` entry |
| 3. `npm test` incl. multi-node merge + cross-node dedupe | Task 4 tests 4–7 |
| 4. 0-book/bot page still errors; explicit, tested aggregate policy | `fetchNode` 0-parse throw; `mergeNodeResults` tests 5–6 (+7) |
| 5. NYT/Goodreads byte-for-byte unchanged | `git diff` shows no edits to those files |
| 6. Env documentation | Task 5 |

## Data / API changes

- **New env var:** `AMAZON_LISTFIC_NODES` — comma-separated Amazon
  browse-node IDs (digits only per token; junk dropped; empty/invalid ⇒
  shipped defaults). Read at fetch time, not module load.
- **Source shape from `amazon.sources()`:** still exactly one
  `{ id, label, tag, configured, fetch }`; `id` changes
  `amazon-new-releases-lit-fic` → `amazon-new-releases` (intentional — see
  decision 5); `tag` unchanged (`Amazon New Releases`), so existing Library
  tag chips keep grouping.
- **Module exports of `src/listsources/amazon.js`:**
  `{ sources, parse, nodeIds, nodeUrl, mergeNodeResults, DEFAULT_NODES }`
  (drops the old `URL` export; nothing else imports it — verify with grep).
- **`src/listsources/util.js`:** gains `entryKey` (moved verbatim from
  `lists.js`); `lists.js` re-exports it, so its public API is unchanged.
- **`parse` stays PURE and unchanged** — one page of chart HTML in,
  `[{ title, author }]` out, no env/network/date access, exported for
  fixture tests. The new `nodeIds`/`nodeUrl`/`mergeNodeResults` are likewise
  pure (nodeIds reads env only) and exported for tests.
- **`lists.json` state:** no schema change. The new source id seeds a fresh
  baseline on first pull; the old snapshot key is orphaned but harmless.

## Risks & watch-outs

- **Bot-block / 503 fragility.** Three requests per pull instead of one
  raises bot-detection exposure. Mitigate: sequential fetches with a ~2s gap
  (`NODE_FETCH_GAP_MS`), same `SCRAPE_HEADERS` as today, and the
  proceed-with-successes policy so one blocked node doesn't blank the radar.
  Also: your dev machine may be blocked even though production isn't — a 503
  during Task 6's live smoke is not a failed implementation.
- **Node-id correctness is the whole feature.** A wrong default id silently
  pulls the wrong genre. That's why Task 0 is first and unverified ids must
  never ship as defaults.
- **Markup drift.** `parse` is untouched, so per-page fragility is the same
  as today; the 0-parse-⇒-error guard per node plus the all-nodes-empty
  throw preserves the "never a silently empty chart" invariant.
- **Dedupe correctness.** Cross-node dedupe MUST use `util.entryKey` (the
  moved function), not a home-grown key — otherwise Amazon-internal identity
  drifts from cross-source identity and the same book could be double-listed
  in a snapshot. The circular-require trap (`amazon.js` ↔ `lists.js`) is why
  `entryKey` moves to `util.js`; do not require `../lists` from a listsource
  module.
- **Ordering constraints.** Task 0 (verify ids) before Task 2 (hardcode
  defaults). Task 1 (`entryKey` move, `npm test` green) before Task 2 (which
  depends on `util.entryKey`). Tests (Task 4) after Task 2's exports exist.
- **Env-state leakage in tests.** Any test that sets
  `AMAZON_LISTFIC_NODES` or stubs `global.fetch` must restore state in
  `finally`/`t.after` — `node --test` runs files in one process per file and
  test order must not matter.
- **Entrant-flood on id change** is deliberately avoided by decision 5; if
  you're tempted to keep the old source id "for continuity", don't — that
  reintroduces the flood.

## Out of scope (restated from the brief — do not build)

- Per-book genre metadata lookup (Google Books / Open Library enrichment).
- Any filtering of the NYT or Goodreads sources.
- A settings-page UI for editing the category set or any blocklist.
- Changing `LIST_MAX_ACTIVE`, tags, digest format, or watcher behavior.
- Title/author keyword blocklists.
