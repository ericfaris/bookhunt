# Concept brief — Amazon new-release radar genre filtering

## Problem
The new-release radar's Amazon source scrapes the broad **"New Releases in
Literature & Fiction"** node (`/gp/new-releases/books/17`). That node lumps
Romance, Paranormal, and other genres this app's audience doesn't want in with
everything else, so the radar surfaces (and auto-watches / digests) too many
romance / vampire / unwanted titles. The scrape returns only `{ title, author }`
— there is **no genre signal** in the current data, so nothing downstream can
filter by genre.

## Goal
Stop unwanted genres (romance/paranormal/etc.) from entering the radar via the
Amazon source, by scraping Amazon's own **narrower sub-category new-release
nodes** instead of the catch-all node — Amazon's category tree *is* the genre
signal. The romance node is simply never fetched.

## Approach (decided with user)
- **Mechanism:** Swap the single broad node-17 scrape for a curated set of
  narrower Amazon sub-category new-release nodes. (Chosen over per-book genre
  lookup and title keyword blocklists.)
- **Scope:** Amazon source only. NYT and Goodreads sources are untouched.
- **Config:** A sensible default node set shipped in code, overridable via an
  **env var** (comma-separated Amazon node IDs, e.g. `AMAZON_LISTFIC_NODES`).
  No settings-UI work. Matches how the rest of the app is configured.

## Default "wanted" category set
Ship these three nodes as the default (user's taste call):
1. **Mystery, Thriller & Suspense**
2. **Literary Fiction**
3. **Historical Fiction**

Explicitly **excluded** by default: Science Fiction & Fantasy, Horror,
Action & Adventure, and (the whole point) Romance / Paranormal.

> **Node IDs must be verified at build time.** Amazon 503's plain server-side
> fetches (bot-block), so the real browse-node numbers for these three
> sub-categories could not be confirmed during discovery. The executor must
> confirm each node number resolves to the right sub-category's *new-releases*
> page before hardcoding it as a default (verify from an environment that
> presents as a browser — the app's own scrape path already does, or check the
> live category tree). Candidate/known values to verify, not to trust blindly:
> Literature & Fiction=17 (current), Literary Fiction≈17061,
> Mystery/Thriller/Suspense≈18, Historical Fiction≈10177.

## In scope
- Refactor `src/listsources/amazon.js` to fetch **multiple** configured nodes
  and merge their entries, replacing the single hardcoded node-17 URL.
- Default node set = the three categories above; overridable via env var.
- Preserve existing safety behavior: a node that parses to **0 books** (bot
  page / markup change) is an error, not a silently-empty chart. With multiple
  nodes, decide sensible aggregate behavior (see open questions).
- Keep the parser PURE and fixture-testable (existing convention); update/extend
  `test/` coverage for the multi-node path.
- Downstream dedupe (`lists.entryKey`) already collapses the same book appearing
  in more than one node — no change needed there, but confirm it holds.

## Out of scope
- Per-book genre metadata lookup (Google Books / Open Library enrichment).
- Any filtering of the NYT or Goodreads sources.
- A settings-page UI for editing the category/blocklist.
- Changing the `LIST_MAX_ACTIVE` cap, tags, digest format, or watcher behavior.
- Title/author keyword blocklists.

## Acceptance criteria
1. With defaults, the Amazon source pulls new releases from the three wanted
   sub-category nodes and **not** from the broad node-17 (so romance/paranormal
   new releases no longer enter the radar via Amazon).
2. The node set is overridable via a documented env var without a code edit.
3. `npm test` passes, including a test proving the multi-node parse/merge and
   the dedupe of a book that appears in two nodes.
4. A node that returns a bot page / 0 parsed books still surfaces as an error
   (no silent empty chart), and one failing node does not silently zero out the
   others (aggregate-failure behavior is explicit and tested).
5. NYT and Goodreads source behavior is byte-for-byte unchanged.
6. README / env documentation notes the new env var and its default.

## Open questions / decisions for the planner
- **Source shape:** one logical Amazon source that fetches all nodes and merges
  (single digest label/tag, current tag `Amazon New Releases`) **vs.** one
  source per node (independent failure isolation, per-category labels).
  *Recommendation:* single merged source keyed off the env var — simplest, keeps
  one tag, and dedupe already handles cross-node overlap. Planner to confirm.
- **Aggregate failure policy:** if some nodes succeed and one 503s/bot-blocks,
  do we (a) fail the whole Amazon pull, or (b) proceed with the successful nodes
  and record the failure? *Recommendation:* proceed with successes as long as at
  least one node returned books; only error if **all** nodes fail or the whole
  set parses to 0. This preserves the "0 books = something's wrong" guard
  without letting one flaky node blank the radar.
- Exact env var name (`AMAZON_LISTFIC_NODES` proposed).

## Relevant files / areas
- `src/listsources/amazon.js` — the source to refactor (URL, `parse`,
  `fetchChart`, `sources`).
- `src/listsources/util.js` — shared `cleanTitle` / `SCRAPE_HEADERS` etc.
  (no change expected; referenced by the parser).
- `src/lists.js` — registers sources, `entryKey` dedupe, `LIST_TAGS`.
- `src/listwatcher.js` — `LIST_MAX_ACTIVE` cap, digest; consumes entrants (no
  change expected).
- `test/` — existing list-source fixture tests (mirror the pattern for the new
  multi-node parse/merge/dedupe cases).
- `README` — env-var documentation.
