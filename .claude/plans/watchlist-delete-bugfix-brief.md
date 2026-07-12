# Concept brief: fix watchlist delete bug + one-time cleanup of non-active watches

## Problem

Two related issues with the Watchlist modal:

1. **Delete is unreliable.** Clicking the 🗑 Remove button on a watch row
   sometimes doesn't actually remove the entry. Separately, the whole
   watchlist sometimes appears empty for a while, and a page refresh brings
   the entries back — i.e. a transient, self-correcting empty state, not a
   permanent data loss.
2. **Stale non-active entries need a one-time sweep.** The live
   `watchlist.json` currently has entries sitting in `fulfilled`, `paused`,
   and `expired` status from before/around the recent auto-remove feature
   (`885b272`) shipped. The user wants the watchlist to contain **only**
   watches that are actively still searching.

## Root-cause investigation already done

A read-only code investigation (this session, via a research subagent) found
three concrete, code-supported contributing issues — none is a smoking gun
proven by reproduction/logs, but the user chose to fix all three defensively
rather than spend time gathering a live repro first:

1. **No stale-response guard on `loadWatchlist()`.** `renderWatchlist()`
   fully rebuilds `#watchlistBody` from a fresh `GET /api/watchlist` on
   every mutating action (delete, pause/resume, recipients save, check-now) —
   `public/app.js` (`loadWatchlist()` ~2619-2662, `renderWatchlist()`
   ~2678-2795). There is no request-sequencing guard (no generation
   counter/AbortController), so if two of these overlap (e.g. a double-click
   on Remove, or Remove on one row while Check-now resolves on another), the
   two `GET` promises can resolve **out of order** and an older response can
   silently repaint the list over a newer one — momentarily showing
   pre-delete or stale state. This is the leading candidate for "watchlist
   goes empty then a refresh brings it back."
2. **Delete failures are silently swallowed, both ends.** `DELETE
   /api/watchlist/:id` (`src/server.js:618-621`) returns `{ ok }` from
   `watchlist.remove(id)` but the frontend's delete handler
   (`public/app.js` ~2785-2790) does `await fetch(...); await
   loadWatchlist();` without ever checking the response status or `{ok}`
   body. A transient failure (or a genuinely-missing id) looks identical to
   success from the user's perspective — the row just stays.
3. **No in-flight feedback/disabling on the delete button.** Unlike the
   "Check now" button (which sets `disabled`/`textContent = 'Checking…'`
   immediately, `public/app.js` ~2751-2752), the delete button gives no
   immediate feedback while its fetch is in flight, inviting a user to
   click it again — which is exactly the double-click scenario in issue #1.
4. **Non-atomic write fallback on the Docker bind mount.** `watchlist.json`
   is bind-mounted as a **single file** in `docker-compose.yml`
   (`./watchlist.json:/app/watchlist.json`), not a directory. `writeAll()`
   (`src/watchlist.js` ~33-40) writes to a `.tmp` file on the container's
   own overlay filesystem and attempts `fs.renameSync(tmp, FILE)` for an
   atomic swap — but renaming across that bind-mount boundary throws
   `EXDEV`, so in production this most likely always falls through to the
   non-atomic fallback (`fs.writeFileSync(FILE, data, 'utf8')` in place,
   already anticipated by a comment in the code at `src/watchlist.js:35`).
   If the process were ever interrupted mid-write (OOM, crash, container
   restart cycling while the headed Chromium browser is under load),
   `watchlist.json` could be left truncated, and `readAll()`'s `catch {
   return []; }` (`src/watchlist.js` ~30) would make the **entire watchlist
   silently appear empty** until the next successful write. This wouldn't
   itself "self-heal" on a page refresh (a `GET` never rewrites the file),
   so if this mechanism is in play, "refresh brings them back" more likely
   means a given occurrence just happened not to hit a truncation, not that
   truncation itself recovered.
5. **Confirmed ruled out:** no polling/auto-refresh interval touches
   `loadWatchlist()` (only unrelated intervals exist: warm-banner rotator,
   session-status poll, search timer, download-list timer). Also confirmed:
   the redesign (`8245da8`) did **not** change the delete handler's logic —
   only the button's label/classes and its position in the DOM (promoted to
   a grid sibling) — verified via `git show 8245da8 -- public/app.js`
   diffing byte-identical handler logic. And the backend datastore itself
   is safe against the classic multi-process lost-update race: this is a
   single Node process (no cluster/fork), and `remove()`/`update()` each do
   a synchronous `readAll()` immediately before `writeAll()` with no
   `await` in between — Node's single-threaded event loop means no other
   handler can interleave mid-function.

## Goal

1. Make watchlist deletion reliable and observable:
   - Guard against stale/out-of-order `loadWatchlist()` responses.
   - Surface delete failures to the user instead of silently no-op'ing.
   - Give the delete button in-flight feedback and prevent double-submission.
   - Make `watchlist.json` writes robust against the Docker bind-mount's
     `EXDEV` rename failure, so a truncated/corrupted file is not a
     plausible failure mode.
2. One-time cleanup: remove every watch currently in the live
   `watchlist.json` that is **not** `status: 'active'` — i.e. delete all
   `fulfilled`, `paused`, and `expired` entries, keeping only active
   watches.

## In scope

**Bug fixes:**
- Add a request-sequencing guard to `loadWatchlist()` (e.g. a monotonically
  increasing token/generation counter checked before applying a response to
  the DOM) so an out-of-order/stale response is discarded rather than
  repainting over newer state.
- Check the `DELETE` response (`res.ok` and/or `{ok}` body) in the frontend
  delete handler; on failure, show an inline error (matching the existing
  `#watchlistNotice`/`.reup-msg warn` pattern already used elsewhere in this
  modal) rather than silently reloading as if nothing happened.
- Disable the delete button (and give it a visual in-flight state, e.g. a
  spinner/dimmed icon) for the duration of its request, mirroring the
  existing "Check now" button's disable-while-pending pattern.
- Harden `writeAll()` in `src/watchlist.js` against the cross-device rename
  failure — e.g. catch `EXDEV` specifically (or any rename failure) and
  fall back to a write that cannot leave the target file truncated (for
  instance: write to the tmp file, then on rename failure, copy the tmp
  file's *content* into the target via a single `writeFileSync` only after
  the tmp write succeeded and was verified — the point is to avoid a
  half-written target file ever being visible to a concurrent read). Apply
  the same hardening anywhere else in the codebase using the identical
  tmp-then-rename pattern for this same file, if any (check
  `src/watchlist.js` fully; the same file is also written by
  `src/watcher.js`'s `update`/`setStatus` calls, which go through the same
  `watchlist.js` functions — no separate write path to patch there).
- Apply the same `DELETE`-response-checking/disabling improvement
  consistently to the other row action buttons if they share the same
  no-feedback problem (Pause/Resume) — check whether this is worth doing in
  the same pass for consistency, but the *required* fix is Remove; Pause/
  Resume hardening is a nice-to-have, not a hard requirement (see
  Acceptance Criteria for what's actually verified).

**One-time cleanup (run once, not a recurring job):**
- Remove every entry in the live `watchlist.json` whose `status` is
  `'fulfilled'`, `'paused'`, or `'expired'`. Keep only `status: 'active'`
  entries. This is a **data cleanup**, not a new recurring backend
  behavior — implement it as a one-off script or admin action that is run
  once against the live file, not as a permanent scheduled sweep.

## Out of scope

- Any change to the *ongoing* auto-remove-on-verify behavior shipped in
  `885b272` — that logic (strict `verified === true && titleMatch === true`
  bar, immediate removal) is correct and unchanged. This brief's cleanup is
  a one-time catch-up for entries that predate/reached fulfilled status
  around that change, not a change to the ongoing rule.
- Any change to the *radar* expiry logic itself
  (`lists.expiredListWatches`, 8-week TTL, `src/lists.js`) — the one-time
  cleanup just removes watches already marked `expired`, it does not change
  how/when watches become `expired` going forward.
- Any change to `MAX_WATCHES`/`LIST_MAX_ACTIVE` politeness caps.
- Any change to the Pause/Resume/Check-now *functional* behavior — only
  the delete path's reliability/feedback and (optionally, if trivial) the
  same in-flight UX polish on other buttons.
- A recurring/scheduled job to keep sweeping non-active watches going
  forward — the ongoing behavior is still "delete on auto-verify" (already
  shipped) plus the radar's own status-flip-to-expired (unchanged); nothing
  new is added that continues removing paused/fulfilled watches after this
  one-time pass. If the user wants paused watches to also auto-delete going
  forward, that would be a separate follow-up decision, not assumed here.
- Full concurrency/locking overhaul of `watchlist.json` (e.g. introducing a
  real file lock, a database, or a queue) — the fix here is scoped to
  making the existing tmp-then-rename write survive the known Docker
  bind-mount `EXDEV` failure mode without leaving a truncated file, not a
  general-purpose concurrency redesign.

## Constraints

- Backend change is limited to `src/watchlist.js` (write-hardening) and
  possibly a small one-off script/route for the cleanup — no other backend
  file needs modification for the bug fix itself.
- Frontend change is limited to `public/app.js` (loadWatchlist/delete
  handler) and possibly minor `public/style.css` additions for an in-flight
  button state — reuse existing classes/patterns
  (`#watchlistNotice`/`.reup-msg warn`, disabled-button styling) rather than
  inventing new ones.
- The one-time cleanup must operate on the actual live `watchlist.json` on
  the running container/host (bind-mounted at
  `/home/eric/projects/bookhunt/watchlist.json` on the host per project
  memory) — the executor should confirm the real file path and current
  contents before and after the cleanup, and should not need a container
  rebuild to perform a one-time data cleanup (a plain Node script run
  against the file, or a temporary admin route hit once via curl, are both
  acceptable — Fable/Opus should pick whichever is simplest and safest and
  say which one they used).
- `node --test test/*.test.js` is the test command (`npm test`) — extend
  `test/watchlist.test.js`/`test/server-download.test.js`-style coverage
  for the write-hardening fix (e.g. simulate an `EXDEV`-like rename failure
  and confirm the target file is never left truncated/corrupted) and for
  any new frontend logic that has a pure/testable seam (the stale-response
  guard's core comparison logic, if factored out testably; full DOM/network
  behavior is not something this suite covers, per prior features' notes on
  frontend not being test-covered).
- This app has no staging environment — the one-time cleanup is a
  production data change on `watchlist.json`. Back up the file (e.g. copy
  to `watchlist.json.bak-<timestamp>`) before running the cleanup, so it's
  trivially reversible if something looks wrong.

## Acceptance criteria

1. Clicking Remove on a watch row reliably removes it from the list on the
   first click, with the button showing a disabled/in-flight state
   immediately and re-enabling only on failure.
2. If a `DELETE` request fails (simulate via a forced non-2xx response or
   similar in a test/manual check), the UI shows a visible error instead of
   silently behaving as if the delete succeeded, and the row is not removed
   from the DOM.
3. Rapidly double-clicking Remove (or triggering an overlapping
   action+reload) does not cause the list to flash back to a stale/older
   state — the most recent `loadWatchlist()` response always wins, verified
   either by a targeted unit test of the sequencing logic or a documented
   manual repro-then-verify in the browser.
4. A simulated cross-device rename failure (`EXDEV`) during a
   `watchlist.json` write does not leave the file truncated/empty/corrupt —
   covered by a new test in `test/watchlist.test.js` that forces the
   rename path to fail and asserts the file's contents are still valid
   JSON containing the expected data afterward.
5. After the one-time cleanup runs, the live `watchlist.json` contains only
   entries with `status: 'active'` — verified by reading the file's
   contents directly (or via `GET /api/watchlist`) before and after, with a
   before/after count reported.
6. `npm test` passes.

## Open questions & decisions made

- **Fix scope:** fix all three (four, counting the write-hardening)
  identified issues now rather than gather logs first. Decided by user.
- **Cleanup bar:** remove **all** currently-fulfilled entries (not just
  those meeting the strict verified+titleMatch bar used by the ongoing
  auto-remove feature). Decided by user.
- **Paused watches:** also removed in this one-time cleanup. Decided by
  user (this was the non-default option — the user explicitly chose to
  clear paused watches too, not just fulfilled ones).
- **Expired watches:** also removed in this one-time cleanup. Decided by
  user.
- **Net effect:** after cleanup, the live watchlist contains only `status:
  'active'` entries — everything else (`fulfilled`, `paused`, `expired`) is
  deleted, once, right now. Going forward, only the existing auto-remove-
  on-verify (already shipped) and the existing radar expiry-to-`expired`
  flip (unchanged, still just a status flip, not auto-deleted going
  forward per Out of Scope) continue to run — i.e. paused/expired watches
  created *after* this cleanup will NOT be auto-deleted; only this one pass
  clears out what's there today.
- **Confirmation gate for this run:** the user opted to **skip** the
  Phase 3 plan-review gate for this feature — Fable's plan should be
  sanity-checked by the orchestrating (Sonnet) session and then passed
  straight to Opus for execution without pausing for user approval, unless
  the sanity-check turns up something seriously wrong. Given this touches
  live production data (the cleanup) and a real user-facing bug, the
  orchestrating session should pay extra attention during sanity-check to
  the backup/reversibility of the one-time cleanup step specifically.

## Relevant files/areas

- `public/app.js`: `loadWatchlist()` (~2619-2662), `renderWatchlist()`
  (~2678-2795, includes the delete/pause/resume button construction), the
  "Check now" button's existing disable-while-pending pattern (~2751-2752)
  to mirror for delete.
- `src/server.js:618-621` — `DELETE /api/watchlist/:id` route.
- `src/watchlist.js`: `readAll()`/`writeAll()` (~25-46), `remove()`
  (~91-96), `update()`, `setStatus()`.
- `src/watcher.js` — confirmed this is where the ongoing auto-remove
  (`885b272`) lives; not touched by this brief, just context for why some
  live entries are already gone and others (pre-existing fulfilled/paused/
  expired) are the ones being cleaned up now.
- `src/lists.js` — `expiredListWatches()`, context only, not modified.
- `watchlist.json` (bind-mounted at
  `/home/eric/projects/bookhunt/watchlist.json` on the host) — the live
  data file the one-time cleanup operates on.
- `docker-compose.yml` — confirms the single-file bind mount that causes
  the `EXDEV` rename-fallback behavior.
- Tests: `test/watchlist.test.js` (extend with the write-hardening/EXDEV
  test), `test/watcher.test.js` (context only, not expected to need
  changes since the auto-remove feature itself isn't being modified).

## Repo commands & tree state

- **Test:** `npm test` (runs `node --test test/*.test.js`). Scoped:
  `node --test test/watchlist.test.js`.
- **Run locally:** `npm start` (`node src/server.js`) or `npm run dev`
  (`node --watch src/server.js`).
- **No build step** — plain Node, no bundler.
- **Rebuild/redeploy (after this session):** `npm run docker:up` (per
  project convention — stamps version/commit/build-time; do not use plain
  `docker compose up`). The orchestrating session, not Opus, will run this
  after the build is verified, per the pattern used in the two prior
  features this session (auto-remove-on-verify, then the row redesign).
- **Working tree:** clean on `main`, up to date with `origin/main`, at
  commit `8245da8` (the row-redesign feature, v1.17.0) when this brief was
  written. `git log --oneline -5` for reference:
  ```
  8245da8 Library & Watchlist: redesign rows for progressive disclosure (v1.17.0)
  885b272 Watchlist: auto-remove entries once acquisition is verified (v1.16.0)
  d336b7a Amazon radar: genre-filter via curated sub-category nodes (v1.15.0)
  b26ebb7 Radar digest email: branded card design + cover thumbnails (v1.14.0)
  39eb9b5 Library title hygiene + reader-portal hardening (v1.13.1)
  ```
