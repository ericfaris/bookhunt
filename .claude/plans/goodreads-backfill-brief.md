# Concept Brief: One-Time Goodreads "Most Read" Backfill

## Problem

BookHunt's new-release radar (issue #33, `src/listwatcher.js` + `src/lists.js`) only ever
watches books that are **new entrants** on a day-over-day diff of each source page. It has
been running since 2026-07-04 (NYT) / 2026-07-11 (Goodreads), so it has never looked at, and
will never retroactively look at, books that were *already* on a list's page before the radar
started tracking it. The user wants to catch up: pull in books from the Goodreads "Most Read
(Adult Fiction)" page that the radar never saw, without dumping 100 books into the watchlist
at once.

**Important constraint:** Goodreads does not expose a true historical archive of this list —
only the current top-100 snapshot (verified live 2026-07-14: `goodreads.sources()[1].fetch()`
via `src/listsources/goodreads.js` returned exactly 100 `{title, author}` entries for
`https://www.goodreads.com/genres/most_read/adult-fiction`). "All the history" is interpreted
as "the current full Most Read page," which is the best available proxy for what was missed.

## Goal

A **one-time, user-triggered backfill** that:
1. Fetches the current Most Read (Adult Fiction) page in full (not diffed against a snapshot).
2. Filters out books already owned (Library) or already actively watched (any source).
3. Queues the remainder and trickles them into the watchlist gradually — sharing the existing
   daily radar's intake budget rather than a separate one — landing on a "rough pace" of
   roughly 5/day within that shared budget, so it finishes over about two weeks depending on
   how much headroom the live radar leaves each day.
4. Runs once. The Settings button that triggers it disables once started, and only re-enables
   after the backfill queue is fully drained (all entries watched, owned, or otherwise
   resolved) — so a second click can't queue an overlapping backfill.
5. Reuses all of the existing radar's acquisition machinery (the watcher acquires backfilled
   watches exactly like any other `source: 'list'` watch) and its digest email (backfilled
   "now watching" events appear in the same digest as regular radar activity, distinguishable
   by a "— backfill" list label / distinct tag).

This is explicitly **not** a recurring feature. The existing daily radar continues to run
unmodified for ongoing new-release tracking; backfill is a separate, self-draining, one-shot
queue that piggybacks on the same daily `run()` tick and the same intake ceiling.

## In scope

- A persisted backfill queue + status (`idle` / `running` / `done`) in `lists.json`
  (`src/lists.js` state), survives restarts.
- A trigger to start the backfill: **Settings UI button** ("Backfill from Most Read"), wired
  through a new API endpoint. Button reflects current status (disabled while running,
  re-enabled once `done`) and shows rough progress (e.g. "42 of 78 watched").
- Backfill draws from the **same 10/day intake cap** the live radar already uses
  (`settings.getListMaxPerRun`, `src/settings.js`), but **live radar new entrants always get
  first claim** on that day's slots; backfill only spends what's left over, capped at a
  smaller per-day ceiling (rough pace ~5/day) so it never eats the whole shared budget on a
  quiet radar day.
- Ownership is re-checked at drain time (not just at queue-build time) via the existing
  `library.ownsBook()` guard (`src/library.js`, added in v1.20.0) — a book acquired some other
  way between queueing and draining is skipped, not double-watched.
- If the standing-pool ceiling (`LIST_MAX_ACTIVE`, currently 40) is full on a given day,
  backfill entries for that day are **not** dropped — they stay in the queue and are retried
  the next run (unlike the live radar's permanent "skip-full" for its own new entrants). This
  is a deliberate consequence of sharing the cap; flag as a risk in the plan (backfill can
  stall for a while if the pool stays saturated).
- Backfilled watches carry a tag/label distinguishing them from live-radar watches (e.g.
  `listLabel: 'Goodreads Most Read (Adult Fiction) — backfill'`, plus a distinct Library tag)
  so they're visually identifiable in the Watchlist, Library, and digest email.
- Digest: backfilled "now watching" events ride the existing `SECTIONS`/`buildDigest` pipeline
  in `src/listwatcher.js` (reuse the `watching` event type, just with the distinct list
  label). A short completion note in the digest when the queue finishes draining is a nice
  bonus (new lightweight event type) but not required if it adds meaningful complexity.
- Unit tests for the new pure logic (queue filtering, per-day draw amount, drain decision).

## Out of scope

- Any change to the live daily radar's own diff/new-entrant behavior, caps, or priority
  ordering (all shipped in v1.20.0, `86dc1dd`) — this feature only adds a second, independent
  queue that shares the same `run()` tick and the same top-level intake ceiling.
- Backfilling the Goodreads "New Releases" page or the NYT lists — user asked specifically for
  "Most Read" only.
- A general-purpose "backfill any list" framework — build this for Most Read only; do not
  over-abstract for hypothetical future sources.
- Recomputing an exact 14-day pace based on remaining count/days-left — a fixed rough daily
  rate is enough (user confirmed "rough pace," not "exact 14-day target").
- Retrying/resuming a partially-drained backfill differently from "leave it in the queue and
  drain more next run" — no separate pause/resume/cancel UI beyond the disable-while-running
  button state.
- Any change to `LIST_MAX_ACTIVE` (40) or `settings.getListMaxPerRun` default (10) — reuse
  as-is.

## Constraints

- Must reuse `library.ownsBook()`, `watchlist.add()`/`watchlist.update()`,
  `lists.readState()`/`writeState()`, and the existing digest pipeline
  (`buildDigest`/`sendDigest`/`scheduleDigestSoon`) rather than reimplementing parallel
  versions.
- `lists.json` state is currently `v: 2` (see `migrateState` in `src/lists.js`). Adding a new
  optional `backfill` key to the state object does **not** require a version bump — 
  `readState()` already spreads sane defaults (`{ snapshots: {}, seen: {}, pendingEvents: [],
  lastRunAt: null, ...data }`), so an absent `backfill` key on old state files should resolve
  to a safe default (e.g. `{ status: 'idle', queue: [], startedAt: null, totalCount: 0 }`) via
  the same pattern — do not force a full migration unless the planner finds a reason to.
- Docker bind-mount gotcha applies to `lists.json` same as always (see
  [[bookhunt-runtime]] memory / existing comments in `src/lists.js` `writeState`): keep using
  the existing atomic-with-fallback write, don't introduce a new file.
- This machine is not bot-blocked by Goodreads (verified live during discovery) — the queue
  can be built with one live `fetch()` call at button-click time, no need to reuse a stale
  snapshot.
- Follow existing code conventions: PURE functions exported for unit tests (see
  `classifyEntrant` in `src/listwatcher.js` as the template), atomic JSON writes, fail-open
  ownership checks, hourly-tick + due-check scheduling pattern.

## Acceptance criteria

1. Clicking "Backfill from Most Read" in Settings fetches the current Most Read page live,
   builds a queue excluding already-owned and already-actively-watched books, and persists it
   to `lists.json`. The button becomes disabled and shows a running/progress state.
2. On each subsequent radar `run()` (whether via the hourly scheduler or "Check lists now"),
   after live-source new entrants are processed, leftover intake budget (capped at the rough
   daily backfill rate) is spent draining entries from the backfill queue into new
   `source: 'list'` watches with a distinguishable label, exactly like a live new entrant would
   be (tagged, added to `pendingEvents`, picked up by the existing watcher).
3. A book that becomes owned between queueing and its drain turn is skipped at drain time (not
   watched), and removed from the queue.
4. If the standing-pool ceiling is full on a given day, backfill entries stay in the queue
   (not dropped) and are retried on a later run.
5. Once the queue is fully drained (watched + owned + otherwise resolved = original count), the
   backfill status flips to `done`, the button re-enables, and this state survives a container
   restart (persisted in `lists.json`).
6. Digest emails sent while the backfill is active include backfilled "now watching" events
   alongside any regular radar activity that day, and the backfilled entries are visually
   distinguishable (label/tag) from organically-discovered new entrants.
7. The existing daily radar's own new-entrant behavior, caps, and priority are provably
   unchanged — the full existing test suite (`npm test`, 411 tests as of v1.20.0) still passes,
   plus new tests for the backfill queue-build filter, the per-day draw amount (live-first,
   capped leftover), and the drain decision (owned / pool-full-defer / drain).
8. Clicking the button again while `status === 'running'` is a no-op (button disabled
   client-side; server endpoint also rejects/no-ops server-side, not just UI-side, since the
   endpoint could be hit directly).

## Open questions & decisions made

- **Owned/duplicate filtering:** exclude at queue-build time (Recommended, chosen).
- **Cap sharing:** share the existing 40-active / 10-per-day caps with the live radar, rather
  than a separate budget (chosen — accept the "can stall if pool stays full" risk noted above).
- **Trigger:** Settings UI button (chosen), not a CLI script or bare API endpoint.
- **Budget priority when both have books waiting:** live radar always first, backfill only
  gets leftover slots each day (chosen).
- **Pace:** rough fixed daily rate (chosen; ~5/day within the shared leftover budget), not a
  recomputed exact-14-day target.
- **Digest inclusion:** backfilled watches appear in the regular digest email (chosen), not
  silent/UI-only.
- **Re-run behavior:** button disables once started, only re-enables after full completion
  (chosen) — not "always allowed, re-queue fresh."
- Left to the planner: exact tag/label string used to distinguish backfill watches (e.g.
  `'Backfill'` vs `'Library catch-up'`), whether to add a small digest completion-notice
  section or skip it if it meaningfully complicates `buildDigest`, and the exact shape/field
  names of the new `backfill` state object and API response.

## Relevant files/areas

- `src/lists.js` — state read/write (`readState`, `writeState`, `migrateState`), source
  registry (`sources()`), pure helpers (`entryKey`, `newEntrants`). Backfill state likely lives
  here as a new top-level key.
- `src/listwatcher.js` — the `run()` loop (lines ~68–208 as of this writing), `classifyEntrant`
  (pure decision helper, the pattern to follow for the drain decision), digest pipeline
  (`SECTIONS`, `buildDigest`, `sendDigest`) starting ~line 210. This is where the "drain
  leftover budget into backfill after live entrants" step gets added.
- `src/listsources/goodreads.js` — `sources()` returns the Most Read source
  (`id: 'goodreads-most-read-adult-fiction'`); its `fetch()` is what queue-building calls
  directly (bypassing the normal diff-against-snapshot path).
- `src/settings.js` — `getListMaxPerRun()` / `DEFAULT_LIST_PER_RUN` (10), `LIST_MAX_ACTIVE`
  lives in `listwatcher.js` (40) — read, don't modify, unless the planner needs a new small
  constant for the backfill-specific daily rate (e.g. `BACKFILL_MAX_PER_RUN = 5`).
- `src/library.js` — `ownsBook({title, author})`, fails open, added v1.20.0. Reuse directly.
- `src/watchlist.js` — `add()`, `update()`, `readAll()`; note `add()` dedupes by
  `queryKey` (title+author, case-insensitive) against existing ACTIVE watches and returns the
  existing one rather than duplicating — queue-building should also skip entries already
  matching an active watch's `queryKey` (any source, not just `'list'`) to avoid silently
  reclassifying a hand-added watch's `source`/`tags` via the subsequent `update()` call (a
  pre-existing minor risk in the live-radar path too; just don't make it worse here).
- `src/server.js` — existing `/api/watchlist`, `/api/settings`, `/api/lists/run` endpoints
  (~lines 596–920) are the pattern to follow for a new `/api/lists/backfill/start` (or similar)
  endpoint, and for surfacing backfill status in the existing settings-status GET response.
- `public/index.html` / `public/app.js` — the "New-release radar" Settings section
  (`#setListsEnabled`, `#setListCadence`, `#setListMaxPerRun`, `#setListsRun`,
  `renderListsSettings`, `saveListsSettings` in `app.js`) is exactly the pattern for the new
  backfill button + status text.
- `test/lists.test.js`, `test/settings.test.js` — existing test files with the established
  patterns (pure-function unit tests, `buildDigest` tests) to extend. A new
  `test/backfill.test.js` may be warranted if the surface is large enough — planner's call.

## Repo commands & tree state

- **Test:** `npm test` (⇒ `node --test test/*.test.js`). Node v24.14.0 on `PATH` at
  `/home/eric/.nvm/versions/node/v24.14.0/bin/node`; no venv/other toolchain involved.
- **Rebuild/redeploy (local Docker lab):** `npm run docker:up` (stamps `GIT_SHA`/`BUILD_TIME`
  into the image; do **not** use plain `docker compose up` per project convention). Deployment
  itself is delegated to the `deploy` skill in Phase 6 of this workflow — do not invoke
  `docker:up` manually mid-build.
- **Working tree state at brief time:** clean (`git status --short` empty), `HEAD` at `86dc1dd`
  "Radar intake gating + Library check on manual watches (v1.20.0)", `package.json` version
  `1.20.0`. No pre-existing uncommitted changes for the executor to worry about.
