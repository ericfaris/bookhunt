# Implementation plan: auto-remove watchlist items once verified in the Library

> Executor context: you have this file and the repo at `/home/eric/projects/bookhunt`.
> The concept brief lives at `.claude/plans/watchlist-auto-remove-brief.md` (same
> decisions restated here — this plan is self-contained). Working tree was clean on
> `main` when this was written. Plain Node project, no build step. Tests:
> `npm test` (= `node --test test/*.test.js`).

## Summary

When the background watcher (`src/watcher.js`) finds a watched book and the accepted
premium download passes **strict** verification — `verified === true` **and**
`titleMatch === true` — the watch entry must be **deleted** from `watchlist.json`
(via the existing `watchlist.remove(id)`) instead of being left behind as a
`status: 'fulfilled'` row, so fulfilled watches stop piling up and cap slots
(`MAX_WATCHES = 200`, `LIST_MAX_ACTIVE = 75`) free up sooner. Any weaker outcome
(notify-only match, unverified download, or `titleMatch === null` "couldn't read
metadata") keeps today's behavior exactly: the watch flips to `fulfilled` and stays.
The rule applies uniformly to manual watches and radar-origin watches
(`source: 'list'`); radar digest events keep flowing because they are queued in
`lists.json`, not in the watch record.

## Approach & key decisions

**Where the change lives.** `checkWatch()` in `src/watcher.js` (currently lines
156–220) is the single point where a match is recorded — both the periodic `tick()`
and the "Check now" button (`checkNow()`) funnel through it. The fulfilled-update
at lines 177–185 becomes a conditional: strict pass → `watchlist.remove(watch.id)`;
otherwise → the existing `watchlist.update(..., { status: 'fulfilled', ... })`
unchanged.

**How `checkWatch()` learns the verification outcome.** Today `autoDeliver()`
returns only `{ downloaded, delivered, kindlePushed }` — the accepted download
object (with its `verified` / `titleMatch` fields, produced by
`downloader.verifyBook()`, `src/downloader.js:76-98`) never leaves the function.
Extend the return value with one boolean:

```js
verifiedMatch: !!(download && download.verified === true && download.titleMatch === true)
```

computed from the *final* `download` variable (i.e. after the existing
`titleMatch === false` rejection has already nulled it out, and after the
`(r.downloads || []).find((d) => d.verified)` acceptance pick). This keeps the
strict bar in one place and keeps `checkWatch()`'s decision a one-line check.

- *Rejected alternative — return the raw `download` object:* leaks a large internal
  structure into a return contract that tests and future callers would couple to;
  a single named boolean states the intent ("this download met the removal bar").
- *Rejected alternative — loosen/reuse `downloadRank()` (`src/downloader.js:413-418`):*
  `downloadRank` deliberately treats `titleMatch !== false` (true **or null**) as
  acceptable — that is the *delivery* bar and must not change (brief constraint).
  The removal bar is intentionally stricter (`titleMatch === true` only), so it
  must be a separate check, not a `downloadRank` tweak.
- *Rejected alternative — a later sweep/cleanup pass:* the brief explicitly requires
  removal in the same tick as verification, with no "Found ✓" grace period.

**Asymmetry is intentional.** A book with `titleMatch === null` is still delivered
and pushed to Kindle exactly as today (delivery bar unchanged), but its watch is
*not* removed — it goes `fulfilled` and stays visible. Do not "fix" this.

**Ordering inside `checkWatch()`.** `history.add({type: 'watch-hit', ...})` and the
radar's `lists.recordEvent(...)` both build their payloads from the in-memory
`watch` and `top` objects, not from `watchlist.json`, so removal order is
functionally irrelevant — but keep the current statement order (record the outcome
where the update sits today, then history, then radar event) so the diff stays
minimal. On the removal branch, skip the `watchlist.update()` entirely (do not
write `base` fields to a row you are about to delete, and do not call `update`
after `remove` — `update` on a missing id is a harmless no-op, but it's dead code).

**No new deletion primitive.** Reuse `watchlist.remove(id)`
(`src/watchlist.js:87-92`) as-is. No changes to `src/watchlist.js` logic are
needed — only its schema comment (see Task 3).

**Frontend: no code change.** `public/app.js:2631-2702` renders a "Found ✓" badge,
`foundUrl` link, and delivered counts for `status === 'fulfilled'` rows, and hides
the "Re-activate" control for non-fulfilled rows (`:2702`). All of that code is
driven per-row off whatever `GET /api/watchlist` returns; a removed watch simply
never appears, and the remaining states render exactly as before. The
`titleMatch: null` case still produces a fulfilled row with the badge. Verify by
reading that block (read-only) that nothing assumes fulfilled rows accumulate
(nothing does — it's a straight `.map()` over the list); do not edit it.

## Step-by-step tasks

Each task is independently verifiable; do them in order.

### Task 1 — `src/watcher.js`: expose the strict-verification outcome from `autoDeliver()`

- In `autoDeliver()` (lines 71–153), change the final return (line 152) from
  `return { downloaded: !!download, delivered, kindlePushed };` to also include
  `verifiedMatch: !!(download && download.verified === true && download.titleMatch === true)`.
- Update the JSDoc above `autoDeliver()` (line 69: `Returns { downloaded, delivered,
  kindlePushed }`) to document the new field and its meaning ("the accepted download
  passed the strict bar: verified AND positively title-matched — the watch-removal
  criterion, stricter than the delivery bar").
- Also update the default `delivery` object in `checkWatch()` (line 171:
  `let delivery = { downloaded: false, delivered: 0, kindlePushed: 0 };`) to include
  `verifiedMatch: false`, so the `autoDeliver()`-threw fallback path is well-formed.

Verify: `node -e "require('/home/eric/projects/bookhunt/src/watcher.js')"` loads
clean; existing tests still pass (they don't inspect the return shape beyond the
three original fields).

### Task 2 — `src/watcher.js`: conditional removal in `checkWatch()`

Replace the unconditional fulfilled-update (lines 177–185) with:

```js
if (delivery.verifiedMatch) {
  // Verified, positively title-matched acquisition: the watch has done its job —
  // delete it outright rather than leaving a fulfilled row behind.
  watchlist.remove(watch.id);
} else {
  watchlist.update(watch.id, {
    ...base,
    status: 'fulfilled',
    foundUrl: top.url || null,
    foundAt: new Date().toISOString(),
    delivered: delivery.delivered,
    kindlePushed: delivery.kindlePushed,
    downloaded: delivery.downloaded,
  });
}
```

- Leave the `history.add({ type: 'watch-hit', ... })` block (lines 186–194) and the
  radar `lists.recordEvent` / `scheduleDigestSoon` block (lines 195–207) exactly
  where they are — they must run on **both** branches (the digest email must still
  report the find even when the watch record is gone; acceptance criterion 4).
- Extend the `console.log` at lines 208–214 to say whether the watch was removed
  or marked fulfilled (e.g. append `delivery.verifiedMatch ? ', watch removed' :
  ', watch fulfilled'` — exact wording free, keep it one line).
- Update the file-header comment (lines 3–6, "…and marks the watch fulfilled") and
  the `checkWatch()` JSDoc (line 156, "On a match: notify + mark fulfilled") to
  describe the new remove-or-fulfil behavior.

Verify: covered by Task 4 tests.

### Task 3 — `src/watchlist.js`: schema comment only

Update the shape comment (lines 9–12) to note the lifecycle: e.g. after
`status: 'active' | 'paused' | 'fulfilled'` add a line such as
`// A watch whose acquisition is verified AND positively title-matched is removed
// outright by the watcher (src/watcher.js checkWatch) — 'fulfilled' persists only
// for weaker matches (e.g. titleMatch null / notify-only).`
No logic changes in this file. Note: `setStatus` (line 119) also accepts
`'fulfilled'` and `listwatcher.js:139` writes `status: 'expired'` — leave both alone.

### Task 4 — `test/watcher.test.js`: harness extension + behavior tests

**4a. Extend the `withMocks` harness (lines 17–49).** The new code path calls
`watchlist.remove()`, `lists.recordEvent()`, and (lazily)
`require('./listwatcher').scheduleDigestSoon()`. Unmocked, these would write the
real repo-root `watchlist.json` / `lists.json` and arm a real (unref'd) digest
timer. Add to the harness, following the existing pattern exactly:

- `const lists = require('../src/lists');` and
  `const listwatcher = require('../src/listwatcher');` at the top of the file
  (the lazy `require('./listwatcher')` inside `checkWatch` resolves to the same
  cached module object, so monkeypatching the export works).
- Save/restore + default mocks:
  - `watchlist.remove` → default `() => true` (or `overrides.remove`).
  - `lists.recordEvent` → default `() => {}` (or `overrides.recordEvent`).
  - `listwatcher.scheduleDigestSoon` → default `() => {}` (or
    `overrides.scheduleDigestSoon`).
- Restore all three in the `finally` block alongside the existing restores.

**4b. Update the existing strict-match test** (line 127, `checkWatch: a premium
match auto-downloads, pushes to Kindle, and notifies` — its mock download already
has `verified: true, titleMatch: true`, so under the new behavior the watch is
*removed*, not updated):

- Add a `remove` mock that records the id (e.g. `remove: (id) => { removedIds.push(id); return true; }`).
- Replace the `updatePatch.downloaded === true` assertion (line 160) with:
  - `assert.deepEqual(removedIds, ['w4'])` (removed exactly once, right id);
  - `assert.equal(updatePatch, null)` (no `watchlist.update` call at all — the
    strict path must not write a fulfilled row first).
- Also assert `out.delivery.verifiedMatch === true`.
- Keep every existing assertion about Kindle push, `history.logDownload`, and
  emails — delivery behavior is unchanged.

**4c. New test — verified but `titleMatch: null` stays fulfilled** (acceptance
criterion 2). Same shape as 4b but `premiumDownload` returns
`downloads: [{ filename: 'X.epub', savePath: '/dl/X.epub', verified: true, titleMatch: null }]`.
Assert:
- `out.delivery.downloaded === true` (delivery bar unchanged — null is deliverable);
- `out.delivery.verifiedMatch === false`;
- `remove` was **not** called;
- an update patch with `status: 'fulfilled'` and `downloaded: true` **was** written.

**4d. Extend the existing `titleMatch: false` test** (line 163) — regression check
only: add a `remove` mock and assert it was not called. Do not change anything
else in that test (per the brief: reject-and-skip behavior already covered).

**4e. Sanity note — notify-only match test (line 59)** needs **no change**: with no
premium download, `verifiedMatch` is `false`, so it still goes `fulfilled`, and its
existing assertions (lines 82–84) keep passing. Confirm, don't edit.

**4f. New test — radar-origin watch: removed AND digest event still queued**
(acceptance criterion 4 / digest-decoupling constraint). Strict-match mocks as in
4b, but the watch is
`{ id: 'w6', title: 'Whistler', author: 'Grisham', sort: 'newest', source: 'list', listLabel: 'NYT fiction', recipientIds: [], checkCount: 0 }`.
Capture `recordEvent` and `scheduleDigestSoon` calls. Assert:
- `remove` called with `'w6'`;
- `recordEvent` called exactly once with `{ type: 'added', title: 'Whistler',
  author: 'Grisham', list: 'NYT fiction', url: <the mock thread url> }` — i.e. the
  event payload is complete and intact even though the watch record is gone
  (payload is built from the in-memory `watch`/`top`, which is the decoupling
  being proven);
- `scheduleDigestSoon` was called;
- no operator email was sent (`source === 'list'` stays quiet in `autoDeliver`,
  existing behavior — assert `notify` mock saw no `op@example.com` call, with
  `WATCH_ALERT_EMAIL` set so a regression would be visible).

### Task 5 — `test/watchlist.test.js`: no behavioral additions (documented decision)

`src/watchlist.js` gets no logic change, and its test file deliberately tests only
the pure helpers (`cleanWatchInput`, `dueWatches`, `queryKey`) because
`add`/`remove`/`update` operate on the hardcoded repo-root `watchlist.json`
(`src/watchlist.js:17`) — exercising them in tests would clobber the live file
(bind-mounted into Docker per project convention). The brief's required coverage
(strict-match → removed; `titleMatch: null` → fulfilled; `titleMatch: false` →
unchanged) all lands in `test/watcher.test.js` (Task 4), where `watchlist.remove`
is observed via the mock seam — the same seam the existing suite already uses for
`watchlist.update`. Do **not** add tests that write the real `watchlist.json`.
(If you want a token addition here, a comment in the test file explaining the above
is acceptable; new file-writing tests are not.)

### Task 6 — `test/lists.test.js`: leave unchanged

The digest-decoupling constraint is proven at the call seam in Task 4f.
`lists.recordEvent`/`drainEvents` persistence against the real `lists.json` is
pre-existing behavior with the same live-file hazard as Task 5; the brief requires
verifying decoupling, not re-testing `lists.js` persistence. No edits here.

### Task 7 — version bump + final verification

- Bump `package.json` version `1.15.0` → `1.16.0` (repo convention: feature commits
  carry a minor bump, cf. recent history `v1.14.0`, `v1.15.0`).
- Run the full suite and the scoped suite (commands in the next section).
- Do **not** commit unless the orchestrating session asks; if committing, do NOT
  add a `Co-Authored-By: Claude` line (user's global rule).

## Data / model / API changes

- **`watchlist.json` schema:** no new fields. Behavioral change only: entries whose
  acquisition met the strict bar are deleted instead of persisting with
  `status: 'fulfilled'`. `'fulfilled'` remains a valid, reachable status (weaker
  matches). No migration; no retroactive cleanup of existing fulfilled rows
  (explicitly out of scope).
- **HTTP API:** no endpoint changes. `GET /api/watchlist` simply returns fewer
  rows; `DELETE /api/watchlist/:id` unchanged; a `POST .../check` ("Check now")
  that ends in a strict-verified acquisition leaves the watch absent afterward —
  that is correct, not a bug.
- **Internal contract change:** `autoDeliver()` return value gains
  `verifiedMatch: boolean`. Additive — the only callers are `checkWatch()` and
  tests.
- **`lists.json`:** untouched. Digest events (`pendingEvents`) are recorded exactly
  as today.

## Testing & verification

Commands (from `/home/eric/projects/bookhunt`):

```bash
npm test                                                        # full suite
node --test test/watcher.test.js test/watchlist.test.js test/lists.test.js  # scoped
```

Acceptance-criteria mapping:

1. **Strict match → gone from watchlist.** Task 4b: `watchlist.remove` called with
   the watch id and `watchlist.update` never called on the strict path (so no
   fulfilled row can exist). (`watchlist.remove` itself — filter + write —
   `src/watchlist.js:87-92`, is trivial, pre-existing, and already exercised in
   production via `DELETE /api/watchlist/:id`.)
2. **`titleMatch: null` → fulfilled, not removed.** Task 4c asserts both halves.
3. **`titleMatch: false` → unchanged reject/skip.** Task 4d: existing assertions
   plus remove-not-called.
4. **Radar watch removed + digest intact.** Task 4f: removal and a complete
   `recordEvent` payload plus `scheduleDigestSoon` in the same check.
5. **`npm test` passes.** Task 7. Note `node --test` runs test files in parallel
   processes — another reason the new tests must not touch the real
   `watchlist.json`/`lists.json` (Tasks 5–6).

No end-to-end run is required (the real path needs a warm Mobilism browser
session); the mock seams used are the same ones the existing suite trusts for the
delivery pipeline. Optionally sanity-load the server module graph:
`node -e "require('./src/server.js')"` is NOT safe to run casually (starts
services); prefer `node --check src/watcher.js src/watchlist.js`.

## Risks & watch-outs

- **Unmocked side effects in tests (the biggest trap).** The current `withMocks`
  harness does not stub `watchlist.remove`, `lists.recordEvent`, or
  `listwatcher.scheduleDigestSoon`. If you write the feature first and run the
  existing suite before Task 4a, the updated strict-path test would call the
  *real* `watchlist.remove` and rewrite the repo-root `watchlist.json` (live,
  gitignored, bind-mounted into the running Docker container). Do Task 4a in the
  same change as Task 2, and never let a test hit the real files.
- **Lazy `require('./listwatcher')` in `checkWatch`** (`src/watcher.js:205`,
  cycle-avoidance): monkeypatching works only because Node's require cache returns
  the same module object — patch the export on the required module (as the
  existing harness does for other singletons), don't try to intercept `require`.
- **Compute `verifiedMatch` from the final `download`,** after the
  `titleMatch === false` null-out and the `.find((d) => d.verified)` pick — not
  from `r.downloads[0]`. A multi-mirror result can contain a rejected download
  ahead of the accepted one.
- **Do not touch the delivery bar.** `autoDeliver()`'s accept logic (lines 84–96)
  and `downloadRank()` (`src/downloader.js:406-418`) stay byte-identical.
  `titleMatch: null` must still download, push, and email exactly as today.
- **Don't reorder the radar block to read the watch back from storage.** The
  `recordEvent` payload must come from the in-memory `watch`/`top` (it already
  does); if you refactor, removal-before-record would otherwise lose
  `watch.listLabel`.
- **Strict equality matters:** the bar is `titleMatch === true`. `verifyBook()`
  returns `true | false | null` (`src/downloader.js:76-98`); a truthiness check
  is fine for `true` but write `=== true` anyway to mirror the brief and guard
  against future non-boolean values.
- **Removal branch writes nothing else:** skip the `base` bookkeeping update on
  that branch (there is no row left to bookkeep) and don't call
  `watchlist.setStatus` anywhere new.
- **`checkNow()` after removal:** a second "Check now" on a just-removed watch
  throws `Watch not found` (`src/watcher.js:257`) → the API surfaces an error.
  Pre-existing behavior for deleted watches; acceptable, no handling needed.
- **Frontend:** read `public/app.js:2631-2702` once to confirm the per-row render
  has no dependency on fulfilled rows persisting (it doesn't) — then leave it
  alone.

## Out of scope (restated — do not build)

- Any change to the accept/deliver decision in `autoDeliver()` /
  `downloader.downloadRank()` — the delivery bar stays `titleMatch !== false`.
- Retroactive purge of watches already sitting at `status: 'fulfilled'` in the
  live `watchlist.json`.
- The radar's unmatched-watch expiry path (`lists.expiredListWatches`, 8-week TTL,
  `src/lists.js:57-63`) and the `status: 'expired'` write in
  `src/listwatcher.js:139`.
- `LIST_RECHECK_FLOOR_MS` / `LIST_MAX_ACTIVE` / `MAX_WATCHES` politeness caps.
- Frontend changes (`public/app.js`) — awareness only.
- New deletion primitives, sweep jobs, grace periods, or "removed" history/audit
  UI beyond the existing `history.add('watch-hit')` entry.
- Docker rebuild/deploy (`npm run docker:up`) — code + tests only; the operator
  deploys separately.
