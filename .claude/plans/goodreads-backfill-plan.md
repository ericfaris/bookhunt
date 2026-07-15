# Implementation Plan: One-Time Goodreads "Most Read" Backfill

Concept brief: `.claude/plans/goodreads-backfill-brief.md` (read it too — this plan
resolves its Open Questions but the brief has the full rationale). Repo:
`/home/eric/projects/bookhunt`. Node v24, tests via `npm test` (`node --test test/*.test.js`).

---

## Summary

The new-release radar (`src/listwatcher.js` + `src/lists.js`) only ever watches books that
appear as **new entrants** on a day-over-day diff of each source page, so every book already
on the Goodreads "Most Read (Adult Fiction)" list before the radar started tracking it will
never be picked up. This feature adds a **one-time, user-triggered backfill**: a Settings
button fetches the current Most Read page in full, builds a persisted queue of books not
already owned or actively watched, and trickles them into the watchlist as ordinary
`source: 'list'` watches — draining only the intake budget the live radar leaves unused each
run (a rough ~5/day), carrying a distinguishing label/tag so they're identifiable in the
Watchlist, Library, and digest email. The queue lives in `lists.json`, survives restarts,
self-drains, and flips `status` to `done` when empty (re-enabling the button). Nothing about
the live radar's own diff/cap/priority behavior changes.

---

## Approach & key decisions

The backfill is a **second, independent queue** that piggybacks on the existing daily
`run()` tick in `src/listwatcher.js`. It reuses every existing primitive: `library.ownsBook()`,
`watchlist.add()`/`watchlist.update()`, `lists.readState()`/`writeState()`, and the
`buildDigest`/`sendDigest` pipeline. New pure decision logic follows the established
`classifyEntrant` template (small, exported, unit-tested; no I/O).

### Resolved Open Questions (from the brief)

1. **Tag/label string.** Backfill watches get:
   - `listLabel: 'Goodreads Most Read (Adult Fiction) — backfill'` — the live radar's Most
     Read watches use `'Goodreads Most Read (Adult Fiction)'`, so appending `' — backfill'`
     makes them distinguishable in the Watchlist UI and in the digest's "Now watching" lines
     (which render `(${e.list})`).
   - `tags: ['New release', 'Backfill']` — reuses the existing `LIST_TAGS` first element so
     Library grouping is unchanged, plus a distinct `'Backfill'` chip. Define
     `BACKFILL_TAG = 'Backfill'` and `BACKFILL_LABEL = 'Goodreads Most Read (Adult Fiction) — backfill'`
     as constants in `src/lists.js` (exported, so tests and the drain step share one source of
     truth). Rejected `'Library catch-up'` — less obvious in a tag chip; `'Backfill'` matches
     the feature name the user sees on the button.

2. **Digest completion notice.** **Include it** — it's cheap. Add one new event type
   `'backfill-done'` and one `SECTIONS` entry (`head: 'Backfill complete'`). It rides the
   existing pipeline with zero changes to `buildDigest`'s control flow (the loop already
   iterates `SECTIONS` and skips empty types). The event is pushed to `pendingEvents` the
   moment the queue empties, so it lands in whatever digest that run sends. Rejected skipping
   it: the brief calls it a "nice bonus," and the added complexity is a single array entry.

3. **Backfill state object shape** (new top-level key in `lists.json`):

   ```js
   backfill: {
     status: 'idle',      // 'idle' | 'running' | 'done'
     queue: [],           // [{ title, author }] — remaining, not-yet-resolved entries
     totalCount: 0,       // queue size at build time (the "of N" denominator; fixed once running)
     watchedCount: 0,     // entries turned into watches so far (the "X" numerator)
     ownedCount: 0,       // entries resolved as already-owned at drain time (skipped, not watched)
     startedAt: null,     // ISO when the button built the queue
     finishedAt: null,    // ISO when the queue emptied (status → 'done')
   }
   ```

   `queue.length` shrinks as entries resolve (watched OR owned OR already-actively-watched);
   `totalCount` stays fixed so progress is `watchedCount of totalCount`. `done` is reached when
   `queue.length === 0`. Rejected keeping a separate `resolvedCount`: `totalCount - queue.length`
   is the resolved count already; `watchedCount`/`ownedCount` are enough for the UI + digest.

4. **API response shape.** New endpoint `POST /api/lists/backfill/start`:
   - Success: `{ ok: true, backfill: <public shape below> }` (200).
   - Already running: `{ error: 'Backfill already running' }` (409) — server-side no-op (AC8).
   - Source fetch/parse failure: `{ error: <message> }` (502).
   - Radar not configured: `{ error: 'New-release radar is not configured' }` (400).

   Public backfill shape (used by the endpoint AND folded into `GET /api/status` under
   `lists.backfill`): `{ status, totalCount, watchedCount, remaining }` where
   `remaining = queue.length`. Never ship the full `queue` array to the client — only counts.

### Other decisions carried from the brief (already chosen, restated so the executor doesn't re-litigate)

- **Filter at queue-build time** on owned (`library.ownsBook`) AND already-active watches (any
  source, by `watchlist.queryKey`). Re-check ownership again at **drain** time (a book acquired
  between queueing and draining is skipped, not double-watched).
- **Share the existing caps** (`LIST_MAX_ACTIVE = 40`, `settings.getListMaxPerRun() = 10`). Live
  radar new entrants claim slots first; backfill spends only leftover, capped at a smaller daily
  ceiling `BACKFILL_MAX_PER_RUN = 5` (new env-overridable constant in `src/listwatcher.js`).
- **Pool-full is `defer` (retry), not `skip-full` (permanent).** This is the one behavioral
  difference from `classifyEntrant`: backfill entries stay in the queue when the standing pool is
  full and are retried next run. (Risk: can stall — see Risks.)

---

## Data / model / API changes

- **`lists.json` state** — new optional top-level `backfill` key (shape above). **No version
  bump** (state stays `v: 2`). `readState()` must seed a default so old files resolve safely.
- **New constants**:
  - `src/lists.js`: `BACKFILL_TAG = 'Backfill'`, `BACKFILL_LABEL = 'Goodreads Most Read (Adult Fiction) — backfill'`, `BACKFILL_SOURCE_ID = 'goodreads-most-read-adult-fiction'`, and `defaultBackfill()` returning a fresh state object.
  - `src/listwatcher.js`: `BACKFILL_MAX_PER_RUN = Number(process.env.BACKFILL_MAX_PER_RUN) || 5`.
- **New API endpoint**: `POST /api/lists/backfill/start`.
- **Extended API response**: `GET /api/status` gains `lists.backfill = { status, totalCount, watchedCount, remaining }`.
- **New UI elements**: a "Backfill from Most Read" button + status span in the New-release radar
  Settings section.

---

## Step-by-step tasks

Each step is independently verifiable. Do them in order — later steps depend on the pure
helpers and state defaults from earlier ones.

### 1. `src/lists.js` — state default + constants + pure queue filter

- Add constants near the top (by `LIST_TAGS`, line ~34):
  ```js
  const BACKFILL_TAG = 'Backfill';
  const BACKFILL_LABEL = 'Goodreads Most Read (Adult Fiction) — backfill';
  const BACKFILL_SOURCE_ID = 'goodreads-most-read-adult-fiction';
  ```
- Add `function defaultBackfill()` returning
  `{ status: 'idle', queue: [], totalCount: 0, watchedCount: 0, ownedCount: 0, startedAt: null, finishedAt: null }`.
- In `readState()` (line ~99), add `backfill` to the defaults spread so absent-key old files get a
  safe default and present state is preserved:
  ```js
  return migrateState({ snapshots: {}, seen: {}, pendingEvents: [], lastRunAt: null, backfill: defaultBackfill(), ...data });
  ```
  Also add `backfill: defaultBackfill()` to the hard fallback object at the end of `readState()`
  (the `catch`/non-object path, line ~106). Do **not** touch `migrateState` — no version bump.
- Add a PURE queue-build filter (follows the `newEntrants` style — no I/O, deps injected):
  ```js
  /** PURE: current-page entries minus already-owned and already-actively-watched books,
   *  deduped by queryKey. `isOwned(entry)` and `keyOf(entry)` are injected; `activeKeys`
   *  is a Set of queryKey strings for existing ACTIVE watches (any source). */
  function buildBackfillQueue(entries, { isOwned, activeKeys, keyOf }) { ... }
  ```
  Logic: iterate `entries`, skip falsy/no-title, skip `isOwned(e)`, skip `activeKeys.has(keyOf(e))`,
  skip intra-list duplicates (track a local `Set` of `keyOf`), collect `{ title, author }`.
- Export `BACKFILL_TAG`, `BACKFILL_LABEL`, `BACKFILL_SOURCE_ID`, `defaultBackfill`,
  `buildBackfillQueue` in `module.exports`.

### 2. `src/listwatcher.js` — pure decision + draw helpers

Add alongside `classifyEntrant` (line ~56), exported at the bottom:

- ```js
  const BACKFILL_MAX_PER_RUN = Number(process.env.BACKFILL_MAX_PER_RUN) || 5;
  ```
- `backfillDrawCount({ watchedThisRun, maxPerRun, backfillMaxPerRun, queueLength })` — PURE:
  returns `Math.max(0, Math.min(backfillMaxPerRun, maxPerRun - watchedThisRun, queueLength))`.
  This is the "live radar first, capped leftover" budget: `maxPerRun - watchedThisRun` is the
  slots the live pass left; cap it at the backfill daily rate and at what's actually queued.
- `classifyBackfillEntry({ owned, activeCount, maxActive })` — PURE, mirrors `classifyEntrant`
  but the pool-full branch differs:
  - `owned` → `'owned'` (remove from queue, count `ownedCount`, don't watch)
  - `activeCount >= maxActive` → `'defer'` (**keep** in queue, retry next run — NOT permanent)
  - else → `'watch'`

  Document the contract in a comment, noting the deliberate divergence from `classifyEntrant`
  (no `skip-full`; the per-run budget is enforced by `backfillDrawCount`, not per-entry).

### 3. `src/listwatcher.js` — the drain step inside `run()`

Insert a backfill drain **after** the `for (const source of lists.sources())` loop finishes
(after line ~180) and **before** the expiry pass (line ~182), so live new entrants have already
spent their slots and `watchedThisRun`/`activeListWatches` reflect them. Guard on
`state.backfill && state.backfill.status === 'running' && state.backfill.queue.length`.

Implement as a helper `drainBackfill(state, ctx)` (kept in this module; not required to be pure,
but delegate every decision to the pure helpers) where
`ctx = { activeListWatches, watchedThisRun, maxPerRun }`:

1. `const draw = backfillDrawCount({ watchedThisRun, maxPerRun, backfillMaxPerRun: BACKFILL_MAX_PER_RUN, queueLength: state.backfill.queue.length })`.
2. Rebuild a fresh `activeKeys` Set from `watchlist.readAll()` active watches (`watchlist.queryKey`)
   to catch watches added since queue-build.
3. Iterate the queue front-to-back, up to `draw` **watches created** (deferred entries don't
   consume the draw budget). For each candidate:
   - If already in `activeKeys` → treat as resolved: remove from queue, do **not** relabel the
     existing watch (avoids the dedupe-clobber risk), do not increment `watchedCount`. (Optionally
     count as owned-ish; simplest: just drop it silently.)
   - `const decision = classifyBackfillEntry({ owned: library.ownsBook(entry), activeCount: activeListWatches, maxActive: LIST_MAX_ACTIVE })`.
   - `'owned'` → remove from queue, `backfill.ownedCount++`. (No digest event — matches live
     radar, which records owned to `summary` not the email.)
   - `'defer'` → leave in queue, **stop draining this run** (pool is full; nothing else will fit).
   - `'watch'` → `watchlist.add(...)` then `watchlist.update(watch.id, { source: 'list', listLabel: lists.BACKFILL_LABEL, tags: [lists.LIST_TAGS[0], lists.BACKFILL_TAG] })`; `activeListWatches++`; `watchedThisRun++`; `backfill.watchedCount++`; remove from queue; push a `pendingEvents` event `{ type: 'watching', title, author, list: lists.BACKFILL_LABEL }` (same type as live radar → same digest section, distinguishable by label). Wrap `add`/`update` in try/catch like the live path, pushing to `summary.errors` on failure and leaving the entry in the queue.
4. After the loop, if `state.backfill.queue.length === 0`: set `status = 'done'`,
   `finishedAt = new Date().toISOString()`, and push a `{ type: 'backfill-done', count: backfill.watchedCount }` event to `pendingEvents`.
5. Add drained titles to `summary` (e.g. `summary.backfilled = [...]`) for the run log / API.

`state.backfill` is mutated in place; the existing `lists.writeState(state)` at line ~193
persists it. Add a line to the closing `console.log` (line ~202) reporting backfill progress.

### 4. `src/listwatcher.js` — digest section + exports

- Add to `SECTIONS` (line ~212), after the `watching` entry:
  ```js
  { type: 'backfill-done', head: 'Backfill complete', line: (e) => `Most Read backfill finished — ${e.count || 0} added to your watchlist` },
  ```
  Leave `COVER_SECTIONS` unchanged (no cover for this housekeeping note).
- Export `backfillDrawCount`, `classifyBackfillEntry`, and `BACKFILL_MAX_PER_RUN` from
  `module.exports` (line ~385) for unit tests. Optionally export `drainBackfill` if you want an
  integration-style test, but the pure helpers are the required coverage.

### 5. `src/server.js` — start endpoint + status surface

- **Status surface**: in `GET /api/status` (line ~900, the `lists:` object), add:
  ```js
  const bf = lists.readState().backfill || lists.defaultBackfill();
  // ...
  lists: {
    configured: ...,
    lastRunAt: ...,
    watching: ...,
    backfill: { status: bf.status, totalCount: bf.totalCount, watchedCount: bf.watchedCount, remaining: (bf.queue || []).length },
  },
  ```
  (Read state once; reuse for both `lastRunAt` and `backfill`.)
- **New endpoint** near `/api/lists/run` (line ~931):
  ```js
  app.post('/api/lists/backfill/start', async (_req, res) => { ... });
  ```
  Logic:
  1. `if (!lists.isConfigured()) return res.status(400).json({ error: 'New-release radar is not configured' });`
  2. `const state = lists.readState();` — `if (state.backfill && state.backfill.status === 'running') return res.status(409).json({ error: 'Backfill already running' });` (server-side no-op — AC8).
  3. Find the Most Read source: `const src = lists.sources().find((s) => s.id === lists.BACKFILL_SOURCE_ID);` — 404/500 if missing (defensive).
  4. `let entries; try { entries = await src.fetch(); } catch (err) { return res.status(502).json({ error: err.message }); }`
  5. Build `activeKeys` from `watchlist.readAll()` active watches (`watchlist.queryKey`), then
     `const queue = lists.buildBackfillQueue(entries, { isOwned: library.ownsBook, activeKeys, keyOf: watchlist.queryKey });`
  6. Set `state.backfill = { ...lists.defaultBackfill(), status: queue.length ? 'running' : 'done', queue, totalCount: queue.length, startedAt: new Date().toISOString(), finishedAt: queue.length ? null : new Date().toISOString() };` then `lists.writeState(state);`
     (Empty queue → immediately `done`: everything is already owned/watched.)
  7. `res.json({ ok: true, backfill: { status: state.backfill.status, totalCount: state.backfill.totalCount, watchedCount: 0, remaining: queue.length } });`

  Confirm `watchlist` and `library` are already required at the top of `server.js` (they are used
  elsewhere; add requires if not). Do not trigger a `run()` here — the drain happens on the next
  scheduled/forced radar tick, matching the "shares the daily tick" design.

### 6. `public/index.html` — button + status

In the New-release radar section (after the `#setListsRun` row, line ~358–361), add:
```html
<div class="set-lists-row">
  <button id="setBackfillRun" class="ghost-btn" type="button">Backfill from Most Read</button>
  <span id="setBackfillStatus" class="hint"></span>
</div>
<p class="hint">One-time catch-up: watches books already on the Goodreads Most Read (Adult Fiction) list that the radar never saw, trickled in a few per day. Runs once.</p>
```

### 7. `public/app.js` — wire the button

- Add a listener near line ~1649: `$('#setBackfillRun').addEventListener('click', startBackfill);`
- In `renderListsSettings(s)` (line ~1714), reflect backfill state from `s.lists.backfill`:
  - Button disabled when `!conf` OR `backfill.status === 'running'`.
  - Status span text:
    - not configured → `''` (or reuse the radar's message),
    - `running` → `Backfilling… ${watchedCount} of ${totalCount} watched (${remaining} left)`,
    - `done` and `totalCount > 0` → `Backfill complete — ${watchedCount} added`,
    - `idle`/`done` with `totalCount === 0` → `Not started`.
- Add `async function startBackfill()` modeled on `runListsNow()` (line ~1771): POST
  `/api/lists/backfill/start`, on `res.status === 409` show "already running", on success show a
  confirmation using the returned `backfill` counts, then `await loadSettings()` to refresh the
  button/status. Reuse the `#setListsResult` result element for feedback.

### 8. Tests — `test/backfill.test.js` (new file)

Follow the `node:test` + `assert` style of `test/lists.test.js`. Cover the three pure surfaces
the brief names (AC7):

- **`buildBackfillQueue`** (`src/lists.js`): excludes owned, excludes entries whose key is in
  `activeKeys`, dedupes intra-list duplicates, drops no-title junk. Inject `isOwned`/`keyOf` stubs
  and a hand-built `activeKeys` Set — no filesystem.
- **`backfillDrawCount`** (`src/listwatcher.js`): live-first + capped leftover:
  - full live budget spent (`watchedThisRun === maxPerRun`) → `0`,
  - leftover larger than the backfill cap → clamped to `BACKFILL_MAX_PER_RUN`,
  - leftover smaller than the cap → equals the leftover,
  - `queueLength` smaller than both → equals `queueLength`,
  - never negative.
- **`classifyBackfillEntry`** (`src/listwatcher.js`): `owned` → `'owned'`; pool full → `'defer'`
  (assert it is NOT `'skip-full'` — the key divergence from `classifyEntrant`); room → `'watch'`.
- Optional: a `buildDigest` test asserting a `backfill-done` event renders the
  "Backfill complete" section (extend the existing `buildDigest` tests in `test/lists.test.js`).

Keep every test offline/pure — no `fetch`, no real `lists.json`.

---

## Testing & verification

Run the full suite plus the new tests:

```bash
cd /home/eric/projects/bookhunt && npm test
```

Expected: the pre-existing suite (411 tests as of v1.20.0) still green, plus the new
`test/backfill.test.js` cases. Map to acceptance criteria:

- **AC1** (button builds+persists a filtered queue, button disables) — `buildBackfillQueue` unit
  tests + manual: POST `/api/lists/backfill/start`, inspect `lists.json` `backfill.queue`/`status`.
- **AC2** (leftover budget drains into labeled watches on each run) — `backfillDrawCount` +
  `classifyBackfillEntry` unit tests; manual: with a running queue, call
  `POST /api/lists/run` and confirm new `source: 'list'` watches with `listLabel` ending
  ` — backfill` appear (up to 5, only if live pass left slots).
- **AC3** (owned-between-queue-and-drain is skipped) — `classifyBackfillEntry` owned→`'owned'`
  test; the drain re-calls `library.ownsBook` per entry.
- **AC4** (pool-full defers, not dropped) — `classifyBackfillEntry` pool-full→`'defer'` test;
  drain leaves the entry in `queue`.
- **AC5** (empties → `done`, re-enables, survives restart) — manual: drain to empty, confirm
  `backfill.status === 'done'` in `lists.json`, restart container, confirm status persists and the
  button re-enables (driven by `GET /api/status`).
- **AC6** (digest includes backfilled "now watching", distinguishable by label) — the `watching`
  events carry `list: BACKFILL_LABEL`; optional `buildDigest` test.
- **AC7** (live radar unchanged) — full `npm test` passes unchanged; no edits to `classifyEntrant`
  or the live-entrant loop.
- **AC8** (second click is a server-side no-op) — manual: `POST /api/lists/backfill/start` twice;
  the second returns 409 while `status === 'running'`.

Optional end-to-end manual check (no rebuild needed for logic): `node -e` requiring the modules and
exercising `buildBackfillQueue`/`backfillDrawCount` with sample data. Deployment
(`npm run docker:up`) is out of scope for the build phase — leave it to the deploy skill.

---

## Risks & watch-outs

1. **Ordering inside `run()` is load-bearing.** The drain MUST run after the source loop (so
   `watchedThisRun` already reflects live new entrants — live-first priority) and before the
   expiry pass and the single `lists.writeState(state)`. Putting it earlier gives backfill first
   claim on the budget (violates AC2 priority); putting it after `writeState` loses the queue
   mutation.
2. **Backfill can stall when the standing pool stays full.** Because pool-full is `defer` (not the
   live radar's permanent `skip-full`), a saturated 40-active pool means zero backfill progress
   until watches expire/fulfil. This is deliberate (brief's chosen cap-sharing) — surface it in the
   status text so a stalled backfill isn't mistaken for a bug. Do NOT "fix" it by bumping
   `LIST_MAX_ACTIVE` (out of scope).
3. **`watchlist.add()` dedupe-clobber (pre-existing, don't worsen).** `add()` returns an existing
   active watch for the same `queryKey`; the follow-up `update()` would then relabel a hand-added
   watch to `source: 'list'` + backfill tags. Mitigate by rebuilding `activeKeys` at drain time and
   skipping any queued entry already in it (remove from queue, no relabel). Same guard at
   queue-build. This only reduces the risk to the level the live radar already carries — don't
   attempt a broader fix.
4. **Docker bind-mount write gotcha.** `lists.json` is a single-file bind mount; `writeState`
   already uses atomic-with-fallback and must not be replaced with a new file or a plain rename.
   Backfill state is just a new key on the same object — reuse `readState`/`writeState` as-is; do
   NOT introduce a second JSON file.
5. **`run()` early-returns gate backfill progress.** Backfill only drains inside a due, enabled,
   configured `run()` (the `not due yet` / `disabled` / `not configured` guards at lines ~69–75
   return before the drain). So progress is ~once/day on the daily pull (or immediately via
   "Check lists now"), which is exactly the intended rough pace — but note it in the plan so the
   executor doesn't try to drain on every hourly tick.
6. **`totalCount` is the fixed denominator.** Set it once at queue-build and never recompute; the
   "X of N" display and the `done` condition (`queue.length === 0`) depend on it staying fixed.
7. **Fail-open ownership.** `library.ownsBook` returns `false` on error by design; a transient
   failure at drain time means a book you own might get watched (the watcher's own verification
   catches it). Do not add a throwing ownership path.
8. **Empty queue at build time.** If every Most Read book is already owned/watched, set `status`
   straight to `done` (not `running`) so the button re-enables immediately and no phantom "running"
   state persists.

---

## Out of scope (restated from the brief — do not build)

- Any change to the live daily radar's diff/new-entrant behavior, caps, or priority ordering.
- Backfilling the Goodreads "New Releases" page or the NYT lists — Most Read only.
- A general-purpose "backfill any list" framework — build for Most Read only; no abstraction for
  hypothetical future sources.
- Recomputing an exact 14-day pace from remaining count / days left — a fixed rough daily rate
  (`BACKFILL_MAX_PER_RUN = 5`) is enough.
- A separate pause/resume/cancel UI beyond the disable-while-running button state.
- Any change to `LIST_MAX_ACTIVE` (40) or `settings.getListMaxPerRun` default (10) — reuse as-is.
- A `lists.json` version bump / migration — the optional `backfill` key defaults in via the
  existing `readState` spread.
```
