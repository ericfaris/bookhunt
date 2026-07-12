# Concept brief: auto-remove watchlist items once verified in the Library

## Problem

When a watched book is found and downloaded, the watch entry in `watchlist.json` is
only ever marked `status: 'fulfilled'` — it is never deleted. Fulfilled watches pile
up indefinitely; only a manual `DELETE /api/watchlist/:id` call removes them. Over
time this muddies the watchlist with entries that no longer need watching.

## Goal

Once a watch has been found **and verified** as correctly downloaded into the
Library, remove it from the watchlist automatically. No lingering "fulfilled"
state — the entry disappears from `watchlist.json` (and therefore from the
watchlist UI) the moment verification succeeds.

## In scope

- Auto-delete the watch entry (`watchlist.remove(watch.id)`) at the point
  `checkWatch()` currently sets `status: 'fulfilled'`
  (`src/watcher.js:177-185`), gated on a strict verification bar (see below) —
  instead of leaving it as a `fulfilled` row.
- Applies uniformly to both manually-added watches and radar-origin watches
  (`source: 'list'`). Radar's own digest-event queuing
  (`src/lists.js` `pendingEvents`, built in `src/watcher.js:196-207`) happens
  independently of the `watchlist.json` record, so removing the watch entry
  must not affect the digest email content.
- **Verification bar: strict.** Only remove the watch when the accepted
  download's `verified === true` **and** `titleMatch === true` (a confirmed
  positive metadata match) — not merely `titleMatch !== false` (which
  currently also accepts `null`, i.e. "couldn't read metadata to compare").
  This is a *stricter* bar than `autoDeliver()`'s existing accept-and-deliver
  bar (`src/downloader.js:406-416`, `src/watcher.js:87-92`), so it is possible
  for a book to be delivered/downloaded and the watch still **not** be
  removed (e.g. `titleMatch === null`) — in that case the watch keeps its
  current behavior: flip to `status: 'fulfilled'` and stay in the list,
  exactly as today. This asymmetry is intentional per user decision.
- Removal happens immediately in the same tick that verification succeeds —
  no separate sweep/cleanup pass, no grace-period display of "Found ✓" before
  deletion.
- Update/extend the relevant unit tests (`test/watcher.test.js`,
  `test/watchlist.test.js`) to cover: strict-match → removed; verified but
  `titleMatch: null` → stays `fulfilled` (unchanged existing behavior);
  `titleMatch: false` → unchanged existing reject-and-skip behavior (already
  covered, don't touch).

## Out of scope

- No change to the accept/deliver decision itself in `autoDeliver()`
  (`src/watcher.js:71-153`, `src/downloader.js:406-416`) — a book with
  `titleMatch: null` still gets delivered as it does today; only the
  *watchlist removal* bar is stricter, not the delivery bar.
  - Consequence to flag: this brief accepts a genuine (if narrow) behavior
    asymmetry — "downloaded" is not always "removed from watchlist" — because
    that's what the user explicitly chose over matching the looser
    `autoDeliver` bar.
- No retroactive cleanup of watches already sitting in `fulfilled` status in
  the live `watchlist.json` today. This brief covers new fulfillments going
  forward only. (If the user wants existing fulfilled entries purged too,
  that's a separate one-off, not part of this feature.)
- No change to the radar's own expiry path (`lists.expiredListWatches`,
  8-week unmatched TTL, `src/lists.js:57-63`) — that's for *unmatched* watches
  expiring, a different case from this feature (which is about *matched and
  verified* watches).
- No change to `LIST_RECHECK_FLOOR_MS` / `LIST_MAX_ACTIVE` politeness caps.
- Frontend (`public/app.js:2631-2702`) currently renders a "Found ✓" badge and
  foundUrl/delivered info for `status === 'fulfilled'` watches. Under strict
  removal, most verified fulfillments will vanish from the list entirely
  before a user ever sees that badge (the exception being the
  `titleMatch: null` case above, which still shows it as before). No frontend
  code change is anticipated, but this behavior shift is worth the executor
  double-checking doesn't break other list-rendering assumptions (e.g. code
  that assumes at least historical fulfilled entries remain visible).

## Constraints

- Existing `autoDeliver()` accept/reject safety net (title-match-false
  rejection) must remain unchanged.
- `watchlist.remove()` (`src/watchlist.js:87-92`) is the existing hard-delete
  primitive — reuse it, don't add a new deletion path.
- Radar digest events are already queued via `lists.js` `pendingEvents`
  independently of the watch record's lifecycle — verify (in tests) that
  removing the watchlist.json entry does not remove or corrupt the queued
  digest event.
- Keep the `MAX_WATCHES = 200` (`src/watchlist.js:19`) and
  `LIST_MAX_ACTIVE = 75` (`src/listwatcher.js:29`) caps as-is; this feature
  should, if anything, help those caps by freeing up slots sooner.

## Acceptance criteria

1. A watch that is checked and gets a download with `verified: true` and
   `titleMatch: true` is deleted from `watchlist.json` (confirmed via
   `watchlist.list()` or reading the file) — it does not appear with
   `status: 'fulfilled'` afterward; it's simply gone.
2. A watch whose accepted download has `verified: true` but
   `titleMatch: null` still ends up with `status: 'fulfilled'` in
   `watchlist.json`, unchanged from current behavior — it is NOT removed.
3. A watch whose search result is rejected (`titleMatch === false`) behaves
   exactly as today: stays `active`, no delivery, no removal (regression
   check only, no behavior change expected).
4. Radar-origin watches (`source: 'list'`) that hit the strict-match bar are
   also removed from `watchlist.json`, and the corresponding digest event is
   still correctly queued/sent (i.e. the digest email still reports the find
   even though the watch record is gone).
5. `npm test` passes, including new/updated cases in `test/watcher.test.js`
   and `test/watchlist.test.js`.

## Open questions & decisions made

- **Removal timing:** immediate, same tick as verification (not a
  fulfilled-then-later-purged two-step). Decided by user.
- **Verification bar:** strict — `titleMatch === true` required, not just
  "not disproved." Decided by user (deliberately stricter than the existing
  delivery bar, accepting the resulting asymmetry).
- **Radar watches:** same rule applies to both manual and radar-origin
  watches. Decided by user.
- **Confirmation gate for this run:** the user opted to **skip** the
  Phase 3 plan-review gate for this feature — Fable's plan should be
  sanity-checked by the orchestrating (Sonnet) session and then passed
  straight to Opus for execution without pausing for user approval, unless
  the sanity-check turns up something seriously wrong.

## Relevant files/areas

- `src/watcher.js` — `checkWatch()` (`:156-220`) and `autoDeliver()`
  (`:71-153`); this is the primary hook point (`:177-185` sets
  `status: 'fulfilled'` today — replace/augment with conditional removal).
- `src/watchlist.js` — `remove(id)` (`:87-92`), `update(id, patch)`
  (`:94-105`), `setStatus` (`:118-124`), schema comment (`:9-12`).
- `src/downloader.js` — `verifyBook()` (`:76-98`) producing `verified` /
  `titleMatch`; ranking logic (`:406-416`).
- `src/lists.js` — `pendingEvents` queue, digest event shape (used by
  `src/listwatcher.js` digest build) — confirm decoupled from
  `watchlist.json`.
- `src/listwatcher.js` — radar-origin watch creation (`:115-120`),
  `LIST_MAX_ACTIVE` (`:29`).
- `public/app.js:2631-2702` — frontend rendering of `fulfilled` status/badges
  — read-only awareness, not expected to need changes.
- Tests: `test/watcher.test.js`, `test/watchlist.test.js`,
  `test/lists.test.js` (digest decoupling check), `test/downloader.test.js`
  (verify/titleMatch semantics, unchanged, for reference only).

## Repo commands & tree state

- **Test:** `npm test` (runs `node --test test/*.test.js`). To scope:
  `node --test test/watcher.test.js test/watchlist.test.js test/lists.test.js`.
- **Run locally:** `npm start` (`node src/server.js`) or `npm run dev`
  (`node --watch src/server.js`). Requires headed browser / WSLg display per
  project memory — not needed just to run unit tests.
- **No build step** — plain Node, no bundler.
- **Working tree:** clean at brief time (`git status` → nothing to commit,
  on `main`, up to date with `origin/main`).
