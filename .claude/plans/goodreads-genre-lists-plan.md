# Implementation Plan: Replace Amazon New Releases with Goodreads Genre-Page Sources

Executor note: you have only this file and the repo. The concept brief lives at
`.claude/plans/goodreads-genre-lists-brief.md` (same directory) if you need
background, but this plan is self-contained. Repo root: `/home/eric/projects/bookhunt`.
Git tree was clean on `main` at plan-writing time. Do NOT commit or push unless
the user asks. Do NOT run `npm run docker:up` (that is the user's manual deploy
step).

## Summary

The new-release radar (`src/lists.js` + `src/listwatcher.js`) currently pulls
from three source modules: NYT Books API (`src/listsources/nyt.js`), a scraped
Amazon new-releases chart (`src/listsources/amazon.js`), and a scraped
Goodreads "popular this month" page (`src/listsources/goodreads.js`). The
Amazon source floods the watchlist with too many books; the user wants it
deleted outright and — together with the old Goodreads monthly source —
replaced by two new Goodreads *genre-page* sources that were manually verified
scrapeable on 2026-07-13:

- `https://www.goodreads.com/genres/most_read/adult-fiction`
- `https://www.goodreads.com/genres/new_releases/adult-fiction`

End state: `src/lists.js#sources()` returns NYT's two list sources (unchanged)
plus these two new Goodreads sources, all conforming to the existing
`{ id, label, tag, configured, fetch }` interface, so nothing downstream
(listwatcher scheduling, digest, `lists.json` snapshots, watchlist auto-add)
changes. `src/listsources/amazon.js` and all its tests/env-var docs are
removed. Version bumps to 1.18.0.

## Approach & key decisions

### Two separate sources, sharing one parser (chosen)

`most_read` and `new_releases` are semantically different signals (popularity
vs. recency), so follow the **NYT pattern** (`src/listsources/nyt.js`: a
`LISTS`/`PAGES` table mapped to N source objects sharing one fetch helper),
NOT the old Amazon pattern (N browse-nodes merged into one logical source with
per-node error tolerance and cross-node dedupe). The two sources:

```js
{ id: 'goodreads-most-read-adult-fiction',    label: 'Goodreads Most Read (Adult Fiction)',    tag: 'Goodreads Adult Fiction', configured: true, fetch: ... }
{ id: 'goodreads-new-releases-adult-fiction', label: 'Goodreads New Releases (Adult Fiction)', tag: 'Goodreads Adult Fiction', configured: true, fetch: ... }
```

Both `fetch` closures call one shared `fetchGenrePage(url)` (parameterized by
URL only — the page markup is identical between the two).

Rejected alternatives:
- **One merged source** (Amazon-style `mergeNodeResults`): rejected — needless
  complexity. With separate sources, a failure of one page is naturally
  isolated per-source by `listwatcher.js` (it already try/catches each
  source's fetch and keeps the old snapshot on failure — see
  `src/listwatcher.js` around line 84), so no merge/partial-failure machinery
  is needed. Cross-source dedupe of books appearing on both pages is already
  handled by the radar's `seen` map keyed by `entryKey` in `lists.js`.
- **Keeping the old `goodreads-popular-this-month` source alongside**:
  rejected — user explicitly confirmed replace, not add.
- **Sequential fetch with an inter-page gap env var** (like the old
  `AMAZON_NODE_GAP_MS`): not needed. These are two independent sources; the
  listwatcher pulls sources one at a time in its own loop already, so no new
  politeness machinery is required. Do NOT add new env vars.

### Parser design (the core of this change)

Both genre pages are **server-rendered** (no `__NEXT_DATA__` JSON like the old
monthly page — the old Apollo-cache parser is useless here and must be
deleted). Each book cover has a prototip tooltip embedded as an **escaped
JS string literal** inside a `new Tip($('bookCoverNNN_ID'), "...", ...)` call
in a `<script>` block. Verified live 2026-07-13: each page has ~100 `new Tip(`
blocks and ~200 `book/show/` links. The escaped HTML inside the string looks
like (after unescaping):

```html
<h2><a class="readable bookTitle" href="https://www.goodreads.com/book/show/123036004-the-berry-pickers">The Berry Pickers</a></h2>
<div>
  by <a class="authorName" href="/author/show/29566882.Amanda_Peters">Amanda    Peters</a><span title="Goodreads Author!">*</span>
</div>
```

Parse steps (all inside one PURE exported function, `parse(html)` — HTML
string in, `[{ title, author }]` out, matching the existing convention in
`nyt.js`/old `amazon.js`/old `goodreads.js` so tests need no network):

1. **Extract each Tip block's escaped-string second argument** with a regex
   that respects backslash escapes, e.g.:
   ```js
   /new Tip\(\$\('bookCover[^']*'\),\s*"((?:[^"\\]|\\.)*)"/g
   ```
   The `((?:[^"\\]|\\.)*)` alternation is essential — a naive `"([^"]*)"`
   would terminate at the first `\"` inside the tooltip HTML (titles and
   blurbs contain quotes).
2. **Unescape the JS string literal**: `\"`→`"`, `\/`→`/`, `\'`→`'`,
   `\\`→`\`, `\n`/`\t`→space (whitespace is later collapsed by
   `cleanTitle`/`cleanAuthor` anyway). A single pass like
   `s.replace(/\\(.)/g, (m, c) => (c === 'n' || c === 't' ? ' ' : c))` is
   sufficient and safe — do NOT attempt `JSON.parse('"' + s + '"')`, which
   throws on non-JSON escapes like `\'`.
3. **Extract title**: first match of
   `/class="readable bookTitle"[^>]*>([^<]+)</` within the unescaped block.
   Run the captured text through `decodeEntities` then `cleanTitle` (both
   from `src/listsources/util.js`).
4. **Extract author**: **first** match of
   `/class="authorName"[^>]*>([^<]+)</` within the block. Co-authored books
   have multiple `authorName` anchors — take the first only, consistent with
   how `authorLastName` in `util.js` keys multi-author bylines by the first
   author. Run through `decodeEntities` then `cleanAuthor` (which collapses
   the internal whitespace runs Goodreads pads names with, e.g.
   `Amanda    Peters` → `Amanda Peters`).
5. Skip blocks with no title; author may be `''`. Return the entries array.
   `parse` itself returns `[]` for a page with no Tip blocks (bot page) — the
   fetch wrapper turns that into a thrown error (same division of labor as
   the old `amazon.js`: pure parse returns what it finds, fetch enforces
   non-empty).

### Error semantics (unchanged pattern)

`fetchGenrePage(url)`:
- `fetch(url, { headers: SCRAPE_HEADERS, signal: AbortSignal.timeout(30000) })`
  — `SCRAPE_HEADERS` from `src/listsources/util.js`, same 30s timeout as
  every other source.
- non-`res.ok` → `throw new Error(\`Goodreads responded ${res.status} for ${url}\`)`.
- `parse()` result empty → `throw new Error(\`Goodreads parsed to 0 books for ${url} — bot page or markup change\`)`.

This is what lets `listwatcher.js` distinguish "genuinely no new books" from
"the scrape broke" — it must never silently return `[]`.

## Step-by-step tasks

Do these in order; each is independently verifiable.

### Task 1 — Capture a live fixture snippet (before touching code)

Fetch one genre page live to ground the parser and the test fixture in real
markup, not this plan's paraphrase:

```bash
curl -sS -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' \
     -H 'Accept-Language: en-US,en;q=0.9' \
     'https://www.goodreads.com/genres/most_read/adult-fiction' > /tmp/gr-most-read.html
grep -c 'new Tip(' /tmp/gr-most-read.html          # expect ~100
grep -o "new Tip(\$('bookCover[^']*')" /tmp/gr-most-read.html | head -3
```

Extract 2–3 raw `new Tip(...)` calls (including their full escaped-string
second argument) to study the exact escape forms present (`\"`, `\/`, `\n`,
possibly `\'`). If the live markup differs materially from the shape described
above (e.g. class names changed), adapt the parser regexes to what you
actually see — the live page is the source of truth.

Fixture convention: `test/fixtures/` exists but contains only a binary
(`book.rar`); every existing parser test in `test/lists.test.js` inlines its
fixture HTML as JS strings (see the current amazon/goodreads tests). **Follow
that convention — inline the fixture in the test file**, trimmed to 2–3 Tip
blocks. Do not add HTML files under `test/fixtures/`.

### Task 2 — Rewrite `src/listsources/goodreads.js`

Full rewrite. Delete the `__NEXT_DATA__`/Apollo parser and `monthUrl` entirely.
New module contents:

- Top comment explaining the genre-page tooltip-scrape approach (mirror the
  explanatory-comment style of the old file and `amazon.js`).
- `const { cleanTitle, cleanAuthor, decodeEntities, SCRAPE_HEADERS } = require('./util');`
  (note: `entryKey` is NOT needed here — no intra-module merge/dedupe).
- A `PAGES` table (analogous to `LISTS` in `nyt.js`):
  ```js
  const PAGES = [
    { id: 'goodreads-most-read-adult-fiction',    label: 'Goodreads Most Read (Adult Fiction)',    url: 'https://www.goodreads.com/genres/most_read/adult-fiction' },
    { id: 'goodreads-new-releases-adult-fiction', label: 'Goodreads New Releases (Adult Fiction)', url: 'https://www.goodreads.com/genres/new_releases/adult-fiction' },
  ];
  ```
- `parse(html)` — PURE, per the design above, exported.
- `unescapeJsString(s)` — the small unescaper; can be a module-private helper
  or exported for direct testing (exporting it is fine but not required if
  `parse` tests cover it through the fixture).
- `fetchGenrePage(url)` — async, per error semantics above.
- `sources()` — `PAGES.map((p) => ({ id: p.id, label: p.label, tag: 'Goodreads Adult Fiction', configured: true, fetch: () => fetchGenrePage(p.url) }))`.
- `module.exports = { sources, parse, PAGES };` (plus `fetchGenrePage` if you
  want to mock-test it — optional).

### Task 3 — Delete `src/listsources/amazon.js`

```bash
rm src/listsources/amazon.js
```

Do **NOT** touch `src/amazon.js` or `test/amazon.test.js` — those are an
unrelated Amazon product-page URL/title scraper used by the Paste button and
browser extension. Only the file under `src/listsources/` goes.

### Task 4 — Update `src/lists.js`

- Remove `const amazon = require('./listsources/amazon');` (line 26).
- Change `sources()` (line 38-40) to
  `return [...nyt.sources(), ...goodreads.sources()];`.
- Update the module header comment block (lines 10-14) which currently says
  "plus scraped Amazon and Goodreads charts (Phase 2)" — reword to reflect
  NYT + two scraped Goodreads genre pages.
- Update the DEDUPE comment example (lines 16-18, `"Whistler: A Novel" on
  Amazon`) — reword the source attribution (e.g. "on a scraped list") or
  attribute to Goodreads; keep the substance of the comment.
- Nothing else in this file changes — `migrateState`, `readState`,
  `writeState`, `recordEvent`, `drainEvents`, and all the exported pure
  helpers stay as-is.

### Task 5 — Text-only touch-ups in `src/listwatcher.js`

The brief forbids changing scheduling/digest *logic*, but acceptance
criterion 6 requires a case-insensitive grep for `amazon` in this file to come
up empty. Two string/comment edits only:

- Line ~25 comment: "the Amazon/Goodreads charts churn much faster than the
  NYT lists" → reword to "the scraped Goodreads pages churn much faster…".
- Line ~240 digest footer string:
  `'Compiled from the NYT bestseller, Amazon new-release, and Goodreads popular fiction lists. …'`
  → `'Compiled from the NYT bestseller and Goodreads adult-fiction lists. …'`
  (keep the trailing "To remove a title, delete it from your Library."
  sentence intact).

No other edits to this file.

### Task 6 — Clean `.env.example`

Remove the Amazon block (currently lines ~79-84): the comment lines starting
"# Amazon chart: which browse-node new-release lists to pull…" through
`# AMAZON_LISTFIC_NODES=`. Leave the NYT_API_KEY block above it untouched.
(`AMAZON_NODE_GAP_MS` appears nowhere in `.env.example` or README — verified —
so this block is the only doc cleanup. README.md has no radar section and its
many "Amazon" mentions all concern the unrelated Paste-button/extension
feature; do not touch README.)

### Task 7 — Rewrite the source-parser tests in `test/lists.test.js`

- **Delete** all `amazon.*` tests: everything from
  `test('amazon.parse: per-item scoping pairs titles with authors', …)` (line
  ~114) through `test('amazon.sources: one merged source with the new id and
  unchanged tag', …)` ending line ~241. That is 9 tests referencing
  `../src/listsources/amazon`.
- **Delete** the two old goodreads tests (`goodreads.parse: reads books +
  authors out of __NEXT_DATA__` and `goodreads.parse: throws on a page without
  __NEXT_DATA__`, lines ~243-261).
- **Add** new tests in their place (keep the `// --- source parsers (fixtures)`
  section header):

  1. `goodreads.parse: extracts title/author from Tip tooltip blocks` — build
     an inline fixture string containing 2–3 `new Tip($('bookCoverNN_ID'),
     "…escaped html…", …)` calls modeled on the live capture from Task 1.
     Cover in one fixture: a normal entry; an entry whose author anchor text
     has internal whitespace runs (assert it collapses); a title containing an
     HTML entity (e.g. `&amp;`) and an escaped quote (`\"` in the raw string,
     which is `\\\"` in the JS test-file literal — see Risks); assert
     `cleanTitle` behavior (subtitle after `:` stripped) flows through.
  2. `goodreads.parse: multi-author byline takes the first authorName anchor`
     — a Tip block with two `authorName` links; assert author equals the
     first.
  3. `goodreads.parse: a page with no Tip blocks yields zero entries` —
     `assert.deepEqual(parse('<html><body>bot check</body></html>'), [])`
     (mirrors the old amazon bot-page test; the throw lives in fetch).
  4. `goodreads.fetchGenrePage / sources fetch: rejects on non-OK and on
     0-book parse` — mock `global.fetch` (save/restore in `finally`, exactly
     like the old `amazon.fetchChart` test at former lines ~202-231 did):
     a 503 response rejects with `/responded 503/`; an OK response whose body
     has no Tip blocks rejects with `/parsed to 0 books/`; an OK response with
     a valid fixture body resolves to the expected entries.
  5. `goodreads.sources: two genre-page sources with the expected ids/tag` —
     assert `sources()` has length 2, ids
     `goodreads-most-read-adult-fiction` / `goodreads-new-releases-adult-fiction`,
     both `tag: 'Goodreads Adult Fiction'`, `configured === true`, and
     `typeof fetch === 'function'` (mirrors the old `amazon.sources` test).

- Everything else in the file (titleCase, normalizeEntry, diff, entryKey,
  migrateState, digest, expiry, settings-clamp tests) stays untouched.

### Task 8 — Version bump

`package.json` line 3: `"version": "1.17.2"` → `"version": "1.18.0"` (minor
bump; matches repo convention — features bump minor, fixes bump patch, per
git log). Do not touch `package-lock.json`'s version fields by hand; if the
repo has one, run `npm install --package-lock-only` after editing, or simply
edit the two `version` fields in the lock file to match — check which pattern
past bump commits used (`git show 8245da8 -- package-lock.json | head`).

### Task 9 — Verification sweep

Run all of the following and confirm:

```bash
cd /home/eric/projects/bookhunt

# 1. Full test suite
npm test

# 2. No dead Amazon-source references (src/amazon.js + test/amazon.test.js are
#    the ONLY permitted hits — they are the unrelated URL helper)
grep -rniE 'AMAZON_LISTFIC_NODES|AMAZON_NODE_GAP_MS|amazon-new-releases|listsources/amazon' src test .env.example README.md
#    → must output nothing
grep -in amazon src/lists.js src/listwatcher.js .env.example
#    → must output nothing

# 3. Old parser fully gone
grep -rn '__NEXT_DATA__\|popular_by_date\|goodreads-popular-this-month' src test
#    → must output nothing

# 4. Live smoke test (NOT part of npm test): both pages return non-empty entries
node -e "
const g = require('./src/listsources/goodreads');
(async () => {
  for (const s of g.sources()) {
    const entries = await s.fetch();
    console.log(s.id, entries.length, JSON.stringify(entries.slice(0, 3)));
    if (!entries.length) throw new Error(s.id + ' returned 0 entries');
  }
})().catch((e) => { console.error(e); process.exit(1); });
"
```

The smoke test should print ~100 entries per source with sane
`{title, author}` pairs (real names, no HTML entities, no escaped backslashes,
no runs of spaces). Eyeball the first few of each. If the live fetch gets
bot-blocked from your environment, that alone is not a code failure — the
unit tests are the merge gate — but note it in your final report.

## Data / model / API changes

**None.** The source-module interface
(`{ id, label, tag, configured, fetch: async () => [{title, author}] }`) is
unchanged; `lists.json` schema (v2), `listwatcher.js` logic, watchlist
pipeline, HTTP endpoints, and UI are all untouched.

Two state-file consequences to be aware of (no code needed for either):

- The orphaned `snapshots['amazon-new-releases']` and
  `snapshots['goodreads-popular-this-month']` keys in the deployed
  `lists.json` simply stop being read — harmless dead data, leave it.
- The two new source IDs have no prior snapshot, so `listwatcher.js`
  **baselines them silently on first pull** (see `src/listwatcher.js` ~line
  88-91: first-ever pull records the snapshot without treating anything as a
  new entrant). The ~100-book pages therefore will NOT flood the watchlist on
  deploy. Do not add any special-case code for this — it already works.

## Testing & verification (acceptance-criteria map)

| Criterion | Proven by |
|---|---|
| 1. `npm test` passes, no old-parser refs | Task 9 steps 1 & 3 |
| 2. `src/listsources/amazon.js` gone, unwired | Task 3 + 4; Task 9 step 2 |
| 3. `sources()` = NYT + 2 Goodreads, right shape | New `goodreads.sources` test (Task 7 #5); optionally also assert `require('./src/lists').sources().map(s=>s.id)` in the smoke step |
| 4. PURE parser, fixture tests: normal / multi-author / zero-books | Task 7 tests #1, #2, #3 (+ #4 for the throw-on-empty path) |
| 5. Live fetch returns non-empty for both pages | Task 9 step 4 (manual smoke, not in `npm test`) |
| 6. No leftover Amazon dead code/env vars | Task 5, 6; Task 9 step 2 greps |
| 7. Version bump | Task 8 (1.18.0) |

## Risks & watch-outs

- **Triple-escaping in the test fixture.** The tooltip argument is an escaped
  JS string inside HTML; your fixture is a JS string *in the test file*
  representing that. A `\"` in the raw page becomes `\\\"` in a
  double-quoted JS test literal (or `\\"` inside a template literal). Get
  this wrong and the test passes against markup that doesn't match reality.
  Ground the fixture in the Task 1 live capture — copy real bytes, don't
  hand-construct from memory. Consider `String.raw` to keep the fixture
  literal readable.
- **Naive string-capture regex.** `"([^"]*)"` truncates at the first escaped
  quote inside the tooltip (book blurbs contain quotes). Use the
  escape-aware `((?:[^"\\]|\\.)*)` form. Also make the Tip-matching regex
  global (`/g`) and non-greedy where needed so 100 blocks don't collapse
  into one match.
- **Do not `JSON.parse` the escaped string.** The page uses JS escapes that
  are not valid JSON (`\'` at minimum); a manual `replace(/\\(.)/g, …)` pass
  is the robust route.
- **HTML entities decode AFTER unescaping, BEFORE cleaning.** Order:
  unescape JS string → regex out anchor text → `decodeEntities` →
  `cleanTitle`/`cleanAuthor`. Titles like "Beach House &amp; Bay" must come
  out with a literal `&`.
- **Multi-author bylines**: take only the FIRST `authorName` anchor. Grabbing
  all and joining would break `entryKey` dedupe against NYT's byline form.
- **Whitespace runs inside author names** (`Amanda    Peters`) are real on
  these pages — `cleanAuthor` already collapses them; just make sure the
  captured text goes through it.
- **The two Amazon files that must survive**: `src/amazon.js` and
  `test/amazon.test.js` are an unrelated product-page URL helper (Paste
  button + browser extension). Any grep-driven cleanup must exclude them.
  Same for README's Amazon mentions (all Paste/extension/Kindle related) and
  `.claude/plans/amazon-genre-filter-{brief,plan}.md` (historical docs — do
  not edit or delete).
- **Ordering**: do Task 1 (live capture) before Task 2 (parser) — the parser
  regexes must match real markup, and the page may have drifted since
  2026-07-13. Do Task 3/4 together (deleting `amazon.js` while `lists.js`
  still requires it breaks every test that loads `src/lists.js`).
- **Zero-entries must throw in fetch, not parse.** Keep the existing division:
  `parse` is total (returns `[]` on garbage), the fetch wrapper throws on
  empty. `listwatcher.js` relies on the throw to keep the previous snapshot
  instead of treating a bot page as "the list emptied out".
- **No new env vars.** Resist adding a gap/config knob; two fixed URLs need
  none, and the brief scopes config expansion out.

## Out of scope (do not build)

- Any other bestseller-list source (USA Today, Publishers Weekly, IndieBound).
- Any change to `src/listsources/nyt.js`.
- Any change to `src/listwatcher.js` beyond the two literal strings in Task 5
  — no scheduling, digest-logic, cap, or floor changes.
- Any change to the `lists.json` snapshot format, state migration, or the
  watchlist auto-add pipeline.
- Genres beyond `adult-fiction`; genre configurability of any kind.
- UI changes of any kind.
- Deploy (`npm run docker:up`) — the user runs that manually afterwards.
- Committing/pushing — leave the working tree with the changes uncommitted
  unless the user says otherwise.
