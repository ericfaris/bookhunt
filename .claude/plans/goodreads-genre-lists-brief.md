# Concept Brief: Replace Amazon New Releases with Goodreads Genre-Page Sources

## Problem

The "new-release radar" (issue #33) currently pulls from three sources: NYT
Bestsellers (official API), Amazon New Releases (scraped), and Goodreads
Popular This Month (scraped). The user finds Amazon's output too voluminous
and too broad — it floods the watchlist with more books than wanted. They
want Amazon removed and replaced with a better-fitting Goodreads source that
still gives variety/breadth without the volume problem.

## Goal

Remove the Amazon New Releases source entirely and replace it (and the
existing Goodreads monthly source) with two new Goodreads genre-page
sources that the user has manually verified are scrapeable and give good
title/author data:

- `https://www.goodreads.com/genres/most_read/adult-fiction`
- `https://www.goodreads.com/genres/new_releases/adult-fiction`

End state: the radar's three sources are NYT Bestsellers (unchanged) +
these two new Goodreads genre-page sources. Total source count stays at
3 logical sources (NYT is 2 list IDs but 1 module), similar shape to today.

## In scope

- Delete `src/listsources/amazon.js` and its wiring in `src/lists.js`.
- Delete Amazon-related tests (the `amazon.*` tests in `test/lists.test.js`,
  lines ~114-241 per current file). Note: `test/amazon.test.js` and
  `src/amazon.js` are UNRELATED (a URL-matching helper for browser links) —
  do NOT touch those.
- Remove Amazon env vars from any docs/`.env.example`/README references
  (`AMAZON_LISTFIC_NODES`, `AMAZON_NODE_GAP_MS`), if such references exist.
- Rewrite `src/listsources/goodreads.js` to scrape the two genre pages
  above instead of (or in addition to — see decision below) the monthly
  `popular_by_date` page.
- Remove the existing `goodreads-popular-this-month` source (the
  `__NEXT_DATA__`/Apollo-cache scraper) — confirmed with user: replace,
  don't keep alongside.
- Update/replace the Goodreads tests in `test/lists.test.js` (currently
  lines ~243-262, testing the old `__NEXT_DATA__` parser) to cover the new
  parser instead.
- Keep `src/lists.js#sources()` wiring simple: concatenate NYT + the new
  Goodreads sources, same pattern as today.

## Out of scope

- No other bestseller-list sources (USA Today, Publishers Weekly,
  IndieBound) — user explicitly said just this swap, not an expansion.
- No changes to NYT source.
- No changes to `src/listwatcher.js` scheduling/digest logic, `lists.json`
  snapshot format, or the watchlist auto-add pipeline — the new source(s)
  must conform to the existing `{ id, label, tag, configured, fetch }`
  interface so nothing downstream needs to change.
- No changes to genre scope beyond `adult-fiction` (user chose "adult-fiction
  only, both pages" — not a curated multi-genre set like Amazon's old
  node list).
- No UI changes.

## Constraints

- Must conform to the existing per-source interface:
  `{ id, label, tag, configured, fetch: async () => [{title, author}] }`
  (see `src/listsources/nyt.js` for the reference shape).
- Must use the shared helpers in `src/listsources/util.js`
  (`cleanTitle`, `cleanAuthor`, `entryKey`, `decodeEntities`,
  `SCRAPE_HEADERS`) rather than reinventing them — this is how
  cross-source dedupe in `src/lists.js` stays consistent.
- Parsers must be PURE functions (HTML string in → entries array out,
  exported for tests), matching the existing convention in `amazon.js` /
  `goodreads.js` / `nyt.js`, so Fable/Opus can write fixture-based unit
  tests without live network calls.
- A scrape that returns 0 books, or a fetch that 4xx/5xx's, should raise a
  clear error (same "bot page or markup change" pattern as
  `amazon.js`/current `goodreads.js`) rather than silently returning
  empty — this is what lets `listwatcher.js` distinguish "genuinely no new
  books" from "the scrape broke."
- Politeness: use `SCRAPE_HEADERS` for the User-Agent/Accept-Language, and
  a timeout consistent with other sources (`AbortSignal.timeout(30000)`).
  No aggressive parallel hammering of goodreads.com — if fetching both
  pages, doing so sequentially (optionally with a small gap, mirroring
  the old Amazon inter-node gap) is fine; there's no strict requirement
  here since it's only 2 requests, not N nodes.

## Data format discovered during research (verified live 2026-07-13)

Both genre pages are server-rendered (no `__NEXT_DATA__` JSON like the old
monthly Goodreads page). Each book cover on the page has an associated
prototip tooltip embedded as an escaped HTML string literal inside a
`new Tip($('bookCoverNNN_ID'), "...", ...)` JS call in a `<script>` block.
That escaped HTML string contains:

```html
<h2><a class="readable bookTitle" href="https://www.goodreads.com/book/show/123036004-the-berry-pickers">The Berry Pickers</a></h2>
<div>
  by <a class="authorName" href="/author/show/29566882.Amanda_Peters">Amanda    Peters</a><span title="Goodreads Author!">*</span>
</div>
...
```

Confirmed via live `curl` fetch of both URLs on 2026-07-13:
- `most_read/adult-fiction`: 200 `book/show/` links, 100 `new Tip(` blocks.
- `new_releases/adult-fiction`: 200 `book/show/` links, 100 `new Tip(` blocks.

Both pages currently yield ~100 books each. Parsing approach: regex-extract
each `new Tip($('bookCover...'), "...ESCAPED_HTML...", ...)` call's escaped
HTML argument, unescape the JS string (`\"` → `"`, `\/` → `/`, `\n` → space,
etc.), then extract title from the `bookTitle` anchor and author from the
`authorName` anchor(s) within it (note: `Amanda    Peters` — internal
whitespace runs need collapsing via `cleanAuthor`, which already does this).
A book can have multiple `authorName` links (co-authors) — take the first,
consistent with how `authorLastName` in `util.js` already handles
"A and B"-style multi-author strings by splitting on " and "/"with"/"&".

Local scratch fixtures saved during research (available to hand off, not
committed to the repo): the two raw HTML pages are in this session's
scratchpad — Fable/Opus should re-fetch live pages to build their own test
fixtures rather than relying on ephemeral scratch files, since scratch
files won't persist into the executor's environment. Recommend the
executor does a fresh `curl` (with the same `SCRAPE_HEADERS` UA) to capture
a fixture snippet for unit tests, then commits a small trimmed fixture
(a handful of `new Tip(...)` blocks) under `test/fixtures/` (check whether
a `test/fixtures/` convention already exists in the repo; if not, inline
HTML strings in the test file — matching how `test/lists.test.js`
currently inlines fixture HTML for the Amazon/Goodreads parser tests — is
also acceptable and keeps with existing convention).

## Design decision: two sources or one merged source?

NYT ships 2 list IDs as 2 separate sources (each with its own `id`/`label`,
shared tag `"NYT Fiction"`). Amazon merged multiple browse-nodes into one
logical source (because they were sub-categories of the same underlying
concept — "curated fiction new releases"). Here, `most_read` and
`new_releases` are semantically different (one is popularity/backlist
signal, the other is recency signal) — recommend following the **NYT
pattern**: two separate sources, e.g.:

```js
{ id: 'goodreads-most-read-adult-fiction', label: 'Goodreads Most Read (Adult Fiction)', tag: 'Goodreads Adult Fiction', configured: true, fetch: fetchMostRead }
{ id: 'goodreads-new-releases-adult-fiction', label: 'Goodreads New Releases (Adult Fiction)', tag: 'Goodreads Adult Fiction', configured: true, fetch: fetchNewReleases }
```

Both sharing one `fetchGenrePage(url)` helper (parameterized by URL) since
the parsing logic is identical between the two pages — only the URL
differs. This is a recommendation, not a hard requirement; Fable should
make the final call but should explain it in the plan if it deviates.

## Acceptance criteria

1. `npm test` passes with no references to the removed Amazon source or
   the old Goodreads `__NEXT_DATA__` parser.
2. `src/listsources/amazon.js` no longer exists; `src/lists.js` no longer
   requires/wires it.
3. `src/lists.js#sources()` returns NYT's sources plus the new Goodreads
   genre-page source(s), conforming to the existing
   `{ id, label, tag, configured, fetch }` shape.
4. New Goodreads parser is a PURE function, unit-tested against a fixture
   (either a small inline HTML string with 2-3 `new Tip(...)` blocks, or a
   file under `test/fixtures/` if that convention exists), covering: a
   normal entry, an entry with a multi-author byline, and a
   zero-books/malformed-page case (throws a clear error).
5. Running the actual fetch against live Goodreads (manual smoke test by
   the executor, not part of `npm test`) returns a non-empty list of
   `{title, author}` pairs for both genre pages.
6. No leftover dead code/env vars referencing Amazon anywhere in `src/`,
   `test/`, or docs (grep for `amazon` case-insensitively in `src/lists.js`,
   `src/listwatcher.js`, and any `.env.example`/README should turn up
   nothing after the change, aside from the unrelated `src/amazon.js`
   URL-matcher and its own test file which must NOT be touched).
7. Version bump in `package.json` (current version `1.17.2`) — follow the
   repo's existing convention of bumping on feature changes (see git log:
   "Watchlist: fix unreliable delete... (v1.17.1)" etc.). This is a
   removal + replacement of a radar source, likely a minor bump
   (e.g. 1.18.0) — executor should use judgment consistent with past
   bumps in git log.

## Open questions & decisions made

- **Plan review**: user chose to skip the plan-approval gate — Sonnet
  (this session) will sanity-check Fable's plan itself and proceed
  straight to the Opus build without pausing for user confirmation,
  unless the plan looks seriously wrong.
- **Genre scope**: adult-fiction only, both pages (most_read + new_releases)
  — confirmed with user, not a curated multi-genre node list like Amazon's.
- **Amazon removal**: full removal (delete file + tests + wiring), not
  disable-in-place — confirmed with user.
- **Existing Goodreads monthly source**: REPLACED (not kept alongside) by
  the two new genre-page sources — confirmed with user.
- **No other bestseller lists**: user explicitly declined researching
  USA Today / Publishers Weekly / IndieBound — this is a scoped swap, not
  an expansion of source count/breadth beyond what's described here.

## Relevant files/areas

- `src/listsources/amazon.js` — DELETE
- `src/listsources/goodreads.js` — REWRITE (new URLs, new tooltip-based
  parser, replacing the old `__NEXT_DATA__` parser)
- `src/listsources/nyt.js` — reference pattern only, no changes
- `src/listsources/util.js` — reuse `cleanTitle`, `cleanAuthor`, `entryKey`,
  `decodeEntities`, `SCRAPE_HEADERS`; no changes expected but read closely
  since the new parser depends on these
- `src/lists.js` — update `sources()` wiring (remove amazon require/concat,
  keep goodreads require/concat)
- `test/lists.test.js` — remove Amazon tests (~lines 114-241), replace
  Goodreads tests (~lines 243-262) with new parser tests
- `test/amazon.test.js` / `src/amazon.js` — DO NOT TOUCH (unrelated URL
  helper)
- `package.json` — version bump
- Check for any `.env.example`, `README.md`, or doc mentions of
  `AMAZON_LISTFIC_NODES` / `AMAZON_NODE_GAP_MS` / "Amazon New Releases" to
  clean up
- `.claude/plans/amazon-genre-filter-{brief,plan}.md` — historical context
  only (documents how/why the Amazon source was built); not to be edited

## Repo commands & tree state

- Test runner: `npm test` (runs `node --test test/*.test.js`) — Node's
  built-in test runner, no separate framework. Node/npm are on `PATH` in
  this environment (verified: repo uses plain `node`/`npm`, no venv or
  wrapper scripts).
- Other scripts (not needed for this task): `npm start`, `npm run dev`,
  `npm run docker:up` (rebuild+restart, stamps version/commit/build-time —
  do NOT run this as part of the build; that's a separate deploy step the
  user runs manually).
- Git tree state at brief-writing time: **clean** (`git status --short`
  produced no output) — no pre-existing uncommitted changes to worry
  about. Current branch: `main`. Do not commit/push unless the user asks.
