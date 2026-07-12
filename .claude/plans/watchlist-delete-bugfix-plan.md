# Implementation plan: watchlist delete reliability fixes + one-time non-active cleanup

**Repo:** `/home/eric/projects/bookhunt` (plain Node + Express, no build step; static frontend in `public/`).
**Companion brief:** `.claude/plans/watchlist-delete-bugfix-brief.md` (same directory as this plan — read it if present, but this plan is self-contained).
**Baseline:** clean `main` at `8245da8` (v1.17.0).

## Summary

The Watchlist modal's Remove button sometimes appears to do nothing, and the list occasionally flashes empty until a refresh. Investigation identified four defensive fixes, all in scope here: (1) `loadWatchlist()` in `public/app.js` has no stale-response guard, so overlapping `GET /api/watchlist` calls can resolve out of order and repaint the list with older data; (2) the delete handler ignores the `DELETE` response entirely, so failures are silent; (3) the delete button gives no in-flight feedback, inviting the double-clicks that cause overlap; (4) `writeAll()` in `src/watchlist.js` falls back to a non-atomic in-place write when `renameSync` fails — which it *always* does in production because `watchlist.json` is a single-file Docker bind mount (`docker-compose.yml:42`) and cross-device renames throw `EXDEV` — so an interrupted write could leave the file truncated and `readAll()`'s `catch { return []; }` would make the whole watchlist appear empty. Separately, a **one-time production data cleanup** removes every entry in the live `watchlist.json` whose `status` is not `'active'` (all `fulfilled`/`paused`/`expired` entries), with a timestamped backup taken first. This is a one-off pass — no new recurring behavior.

## Approach & key decisions

### 1. Stale-response guard (frontend)

A module-level monotonically increasing generation counter. `loadWatchlist()` captures `const seq = ++watchlistLoadSeq;` on entry; after the `fetch` resolves (and in the `catch` path), it bails out before touching the DOM if `seq !== watchlistLoadSeq`. The newest call always wins; older responses are discarded.

- **Rejected: AbortController.** It would also work, but aborting mid-flight adds error-path noise (`AbortError` handling in the catch) for no benefit — the counter is 3 lines and trivially reasoned about.
- **Rejected: serializing calls through a promise queue.** More machinery, and it would make the UI wait on stale requests instead of just ignoring them.

### 2. Delete response checking + visible error (frontend)

The delete handler checks `res.ok`. On HTTP failure (or network throw), it shows a visible warning via the existing `#watchlistNotice` element (`public/index.html:176`, `class="reup-msg warn"`) — the exact pattern the add-watch form already uses at `public/app.js:2593-2596` — and does **not** reload, so the row stays and the button re-enables. On HTTP success it reloads via `loadWatchlist()` regardless of the `{ok}` body: `ok: false` means the id was already gone server-side (the row was stale), and reloading is precisely the right recovery — treat idempotent delete-of-missing as success from the user's perspective.

### 3. In-flight/disabled state on the delete button (frontend)

Mirror the existing "Check now" pattern (`public/app.js:2752`: `checkBtn.disabled = true; checkBtn.textContent = 'Checking…'`). The delete button is icon-only (`🗑`), so: `del.disabled = true; del.textContent = '…';` on click, restored (`del.disabled = false; del.textContent = '🗑';`) only on the failure path. `.ghost-btn:disabled` styling already exists (`public/style.css:200` — opacity 0.6), so **no CSS changes are needed**. As the brief's optional nice-to-have, apply the same disable-while-pending to the Pause/Resume toggle and "Watch again" button (one line each: set `disabled = true` before their `fetch`); do not add response-checking/notice plumbing to those — Remove is the required fix.

### 4. `writeAll()` EXDEV hardening (backend, `src/watchlist.js`)

Refactor the file I/O into two path-parameterized helpers so they are testable against a temp file without touching the live `watchlist.json` (the existing test file explicitly avoids `add`/`remove` for exactly this reason — see the comment at `test/watchlist.test.js:8-12`):

- `writeJsonList(file, list)` — the hardened write:
  1. `data = JSON.stringify(list, null, 2)`.
  2. Write `data` to `file + '.tmp'`.
  3. **Verify** the tmp write by reading it back and confirming it parses to JSON equal in length to `data` (guards against a partial tmp write before we ever touch the target).
  4. Try `fs.renameSync(tmp, file)` — the atomic path (works in local dev / tests).
  5. On rename failure (`EXDEV` on the bind mount, or anything else): `fs.writeFileSync(file, data, 'utf8')` in place, then **verify** the target by reading it back and parsing; **only after successful verification** `fs.unlinkSync(tmp)`. If the fallback write or its verification throws, the tmp file is deliberately left behind as the recovery copy and the error propagates.
- `readJsonList(file)` — the hardened read with recovery: try to parse `file`; if the file **exists but is corrupt** (parse error — distinguish from `ENOENT`, which still returns `[]` as today), attempt `file + '.tmp'`: if the tmp parses to an array, restore it to `file` via `fs.writeFileSync` and return it; otherwise return `[]` as before.

`readAll()`/`writeAll()` become one-liners delegating to these helpers with the module's `FILE` constant. Export `readJsonList` and `writeJsonList` from `module.exports` (under the existing "exported for unit tests" grouping). All callers (`src/server.js`, `src/watcher.js`) go through `readAll`/`writeAll`/`remove`/`update`/`setStatus`, so no other file changes — confirmed there is no second tmp-then-rename write path for this file anywhere else.

- **Why this is a real fix, not documentation:** the crash window that matters is "target file half-written." With verify-before-unlink, the tmp file — a complete, verified copy of the new data — survives any interruption of the in-place target write, and `readJsonList`'s recovery restores it on the next read instead of silently returning `[]`. The only remaining stale-but-valid window (crash between rename-failure and fallback write leaves the *old* content in `file` + new content in tmp; old content parses fine so recovery doesn't trigger) loses one write but never corrupts — acceptable per the brief's explicit "no general concurrency/locking overhaul" scope.
- **Rejected: writing the tmp file next to the target and relying on rename alone.** Inside the container the target is a bind-mounted *file*; its directory is `/app` on the overlay fs, so rename onto the bind-mounted inode throws `EXDEV` no matter where the tmp lives. Also, replacing the file via rename would swap the inode and desync the bind mount (known project gotcha with `lists.json`). The in-place fallback is mandatory in production; the fix is making it safe.
- **Rejected: a lock file / proper database.** Explicitly out of scope.

### 5. One-time cleanup mechanism: a one-off Node script run on the host (chosen over an admin route)

**Chosen: `scripts/cleanup-nonactive-watches.js`, run once on the host against `/home/eric/projects/bookhunt/watchlist.json`.** Rationale: the app's API sits behind Cloudflare Access origin-JWT verification (fails closed), so even `curl 127.0.0.1:3000` needs a CF service token dance; a temporary admin route would require a code change *plus a container rebuild* just to run once, violating the brief's "should not need a container rebuild" constraint. A host-side script needs neither. The script is committed to the repo for auditability but is **wired into nothing** — not `package.json` scripts, not the server, not any scheduler — and its header comment says so.

Script behavior (all synchronous, fail-fast):
1. Resolve the file path: default `path.join(__dirname, '..', 'watchlist.json')`; allow an explicit path as `process.argv[2]` (used by its test).
2. Read and `JSON.parse` the file. If it doesn't exist, isn't an array, or doesn't parse: **abort with a non-zero exit and touch nothing.**
3. **Back up first:** `fs.copyFileSync(file, file + '.bak-' + <ISO timestamp with ':' replaced, e.g. 2026-07-12T14-30-00>)`. If the copy throws, abort — no backup, no cleanup.
4. Filter: `kept = list.filter((w) => w && w.status === 'active')`.
5. Write `kept` back **in place** with a plain `fs.writeFileSync(file, JSON.stringify(kept, null, 2), 'utf8')` — **never via rename**, so the host-side inode is preserved and the running container's single-file bind mount continues to see the same file (the bind-mount inode gotcha above applies on the host side too).
6. Print a before/after report: total before, per-status counts before, total after, backup filename. Exit 0.

At the time of writing, the live file has **23 entries: 8 active, 15 fulfilled** (0 paused / 0 expired currently — but the filter must still remove all three non-active statuses, since counts can change before the executor runs and the user explicitly decided paused and expired go too). Expected outcome ≈ 23 → 8, but report the *actual* counts observed at run time.

## Step-by-step tasks

Do them in this order. Tasks 1–5 are code+tests (verify with `npm test` after each); task 6 is the production data change and comes **last**, after tests pass.

### Task 1 — Harden `src/watchlist.js` writes

File: `src/watchlist.js`.
- Replace the bodies of `readAll()` (lines ~28-35) and `writeAll()` (lines ~37-48) with delegations to two new functions in the same file, `readJsonList(file)` and `writeJsonList(file, list)`, implementing the verify-and-recover design from "Approach" §4. Keep the explanatory comment about bind-mount rename failure, updated to describe the new behavior.
- Add `readJsonList` and `writeJsonList` to `module.exports` under the existing `// exported for unit tests` section.
- Touch nothing else in the file (`add`, `remove`, `update`, `setStatus`, `dueWatches*` unchanged).

### Task 2 — Tests for the write hardening

File: `test/watchlist.test.js` (extend; keep the existing style — `node:test` + `node:assert`, top-of-file comment explains why the live file is never touched).
- All new tests operate on a temp file via `fs.mkdtempSync(path.join(os.tmpdir(), 'watchlist-test-'))`, calling the exported `writeJsonList`/`readJsonList` with that path. Clean up in each test (or use `t.after`).
- **Test A (acceptance criterion 4): forced EXDEV rename failure leaves valid JSON.** Seed the temp file with a known list via a plain write. Stub `fs.renameSync` to throw `Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })` (save the original, restore in a `finally`/`t.after` — `require('fs')` is a shared module object, so watchlist.js sees the stub). Call `writeJsonList(file, newList)`. Assert: `JSON.parse(fs.readFileSync(file))` deep-equals `newList`; the `.tmp` file has been removed.
- **Test B: interrupted fallback write is recoverable.** Simulate the crash state directly: write a valid `newList` to `file + '.tmp'` and truncated garbage (e.g. `'[{"id":"w_1", '`) to `file`. Assert `readJsonList(file)` returns `newList`, and that afterwards `file` itself has been restored to valid JSON deep-equal to `newList`.
- **Test C: corrupt file with no/corrupt tmp returns `[]`** (current safe behavior preserved), and a missing file still returns `[]`.
- **Test D: happy path** — `writeJsonList` then `readJsonList` round-trips, and no `.tmp` remains (rename path, no stub).

### Task 3 — Stale-response guard in `loadWatchlist()`

File: `public/app.js`.
- Immediately above `async function loadWatchlist()` (~line 2619), add a module-level `let watchlistLoadSeq = 0; // stale-response guard: only the newest load may paint`.
- First line inside the function: `const seq = ++watchlistLoadSeq;`.
- After `const data = await fetch(...)` resolves (~line 2623), before any DOM mutation: `if (seq !== watchlistLoadSeq) return; // a newer load superseded this one`.
- In the `catch` block (~line 2658), add the same guard before the `body.innerHTML = ''` / error append.
- The synchronous `body.innerHTML = '<p class="hint">Loading…</p>'` at the top needs no guard (it runs before any await; the newest call's placeholder legitimately wins).

### Task 4 — Delete handler: response check, visible error, in-flight state

File: `public/app.js`, the delete button construction in `renderWatchlist()` (~lines 2785-2790). Replace the handler with logic equivalent to:

```js
del.addEventListener('click', async () => {
  del.disabled = true; del.textContent = '…';
  try {
    const res = await fetch(`/api/watchlist/${w.id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Remove failed (HTTP ${res.status}) — try again.`);
    await loadWatchlist(); // {ok:false} body = already gone server-side; reload clears the stale row either way
  } catch (err) {
    const n = $('#watchlistNotice');
    n.hidden = false;
    n.className = 'reup-msg warn';
    n.textContent = err.message || 'Could not remove the watch.';
    del.disabled = false; del.textContent = '🗑';
  }
});
```

Notes: the button only re-enables on failure (on success the row is repainted away — matches acceptance criterion 1); network-level `fetch` rejections land in the same catch; the notice text is naturally replaced/cleared by the next successful `loadWatchlist()` (it rewrites `#watchlistNotice` at ~lines 2624-2634). No CSS changes — `.ghost-btn:disabled` already exists at `public/style.css:200`.

### Task 5 — (Nice-to-have) in-flight disable on Pause/Resume and Watch again

File: `public/app.js`. In the `toggle` handler (~line 2764) and `again` handler (~line 2775), set `toggle.disabled = true` / `again.disabled = true` as the first statement before the `fetch`. No re-enable needed (the row repaints via `loadWatchlist()`), no response-checking, no notice plumbing. Skip this task entirely rather than let it grow — it is explicitly optional.

### Task 6 — One-time production cleanup (LAST, after `npm test` passes)

- **6a. Create** `scripts/cleanup-nonactive-watches.js` (new `scripts/` directory) implementing "Approach" §5 exactly. Header comment must state: one-off data cleanup, run manually once on the host, intentionally not referenced by `package.json`, the server, the watcher, or any scheduler — do not wire it in.
- **6b. (Recommended) dry-run the script against a copy:** `cp /home/eric/projects/bookhunt/watchlist.json /tmp/claude-*/…/watchlist-copy.json && node scripts/cleanup-nonactive-watches.js <that copy>` and eyeball the report before touching the real file. (A dedicated unit test for the script is not required — Test A–D cover the write-safety logic, and the script's plain `writeFileSync` is deliberate, not shared code.)
- **6c. Record the before state:** `node -e "const l=require('/home/eric/projects/bookhunt/watchlist.json');const c={};for(const w of l)c[w.status]=(c[w.status]||0)+1;console.log(l.length,c)"`.
- **6d. Run it for real:** `node /home/eric/projects/bookhunt/scripts/cleanup-nonactive-watches.js`. Confirm it printed the backup filename and the before/after counts.
- **6e. Verify the after state** with the same one-liner as 6c, confirm every remaining entry has `status: 'active'`, confirm the backup file exists (`ls -la /home/eric/projects/bookhunt/watchlist.json.bak-*`), and re-run the count check once more ~a minute later to confirm the running container's watcher hasn't resurrected anything (see Risks). Include the before/after counts and backup filename in your final report.

## Data / model / API changes

- **No API changes.** `DELETE /api/watchlist/:id` (`src/server.js:618-621`) is untouched — its `{ ok }` contract is fine; the fix is that the frontend now reads it. No new routes (the admin-route option was rejected).
- **No schema changes.** Watch shape and status vocabulary (`active | paused | fulfilled` + radar's `expired`) unchanged.
- **Production data change (the one-time cleanup):** the live `/home/eric/projects/bookhunt/watchlist.json` (bind-mounted into the container at `/app/watchlist.json` per `docker-compose.yml:42`) has every non-`active` entry deleted, once. Currently 23 entries (8 active, 15 fulfilled); expected result is only the active ones remaining. Reversal path: the timestamped backup `watchlist.json.bak-<timestamp>` created in the same directory before the write — restoring is `cp` back over the file (in place, not `mv`, to preserve the inode). The backup filename matches existing `.gitignore` handling? **Check:** `watchlist.json` is gitignored; confirm `watchlist.json.bak-*` doesn't show up in `git status` — if it does, add `watchlist.json.bak-*` to `.gitignore` so live data never lands in a commit.
- **New file:** `scripts/cleanup-nonactive-watches.js` (committed, inert).

## Testing & verification

Test command: `npm test` (= `node --test test/*.test.js`); scoped: `node --test test/watchlist.test.js`. There is no frontend test harness in this repo — frontend criteria are verified by targeted manual checks in the browser (`npm start`, open `http://localhost:3000`, open the Watchlist modal), consistent with prior features.

Mapping to the brief's six acceptance criteria:

1. **First-click remove with immediate in-flight state:** manual — click Remove on a row; the button must immediately dim/show `…` and the row disappear on reload. (Task 4.)
2. **Failed DELETE shows a visible error, row stays:** manual with a forced failure — temporarily change the handler's URL to `/api/watchlist-nope/${w.id}` (or stop the server between page load and click, or use devtools request blocking on `/api/watchlist/*` DELETE), click Remove, confirm `#watchlistNotice` shows the warn message, the row remains, and the button re-enables. Revert the temporary change. Document which method was used.
3. **Overlapping loads — newest wins:** the sequencing logic is 3 lines of counter comparison inline in `loadWatchlist()`; a unit test would require extracting and simulating the async interleave for no real assurance, so verify manually per the brief's allowance: in devtools, throttle to Slow 3G, click Pause on one row and immediately Remove on another (two overlapping `loadWatchlist()`s), confirm the list settles on the final state with no flash back to stale rows. Document the repro in the final report.
4. **EXDEV never leaves a truncated file:** Test A in `test/watchlist.test.js` (forced `renameSync` EXDEV → file still valid JSON with the new data), plus Test B proving the interrupted-fallback recovery. Run: `node --test test/watchlist.test.js`.
5. **Cleanup leaves only `status: 'active'`:** steps 6c/6e — before/after counts from the file itself via the node one-liner, plus the script's own printed report; confirm the backup exists.
6. **`npm test` passes:** run the full suite last; the existing `test/watcher.test.js` mocks `watchlist.remove` (per the comment in `test/watchlist.test.js:8-12`) and must still pass untouched — if the refactor in Task 1 breaks it, the refactor changed a public signature it shouldn't have.

## Risks & watch-outs

- **Ordering is load-bearing:** backup (6c happens before, and the script's own copy step happens before its write) → cleanup → verify. The script must abort before *any* write if the backup `copyFileSync` fails, and must abort touching nothing if the file doesn't parse.
- **The cleanup must never become recurring.** Do not add it to `package.json` scripts, do not require it from `src/server.js` or `src/watcher.js`, no cron/scheduler, no "run on startup" hook. It lives in `scripts/`, is documented as one-off, and is executed exactly once by hand.
- **Bind-mount inode gotcha (both sides):** replacing `watchlist.json` via rename/`mv` — on the host by the cleanup script, or in the container by `writeAll` — desyncs the single-file bind mount (known from `lists.json`). All in-place writes to this file must be `writeFileSync` on the existing path. The hardened `writeJsonList` keeps rename only as the *attempted* fast path (it fails with EXDEV in the container and falls back; it succeeds harmlessly in tests/local dev where there's no mount).
- **Concurrent watcher writes during the cleanup:** the running container's watcher does synchronous read→write cycles on the same file. The dangerous interleave (watcher `readAll` → host cleanup write → watcher `writeAll` restoring deleted entries) has a sub-millisecond window, but it's real. Mitigate by re-checking the file counts a minute after the cleanup (step 6e) and re-running the script if any non-active entry reappears. Do **not** stop the container to run the cleanup — that would kill the warmed headed-Chromium session, a far worse outcome than a retry.
- **The running container still executes the old `writeAll` until rebuilt.** That's fine — the cleanup is independent of the code fix, and the hardening ships on the next `npm run docker:up`. **Do not run the rebuild/deploy yourself**: per project convention the orchestrating session runs `npm run docker:up` (never plain `docker compose up`) after verifying the build. Likewise leave the version bump (`package.json` is at 1.17.0) and the commit to the orchestrating session unless it instructs otherwise; if you do commit, do not add `Co-Authored-By: Claude` lines (user's global rule).
- **`fs.renameSync` stubbing in tests:** restore the original in `t.after`/`finally` even on assertion failure, or later tests in the same process will fail bizarrely.
- **Don't over-guard `loadWatchlist()`:** the guard protects DOM writes only. Don't wrap the fetch in an AbortController or debounce callers — mutating handlers still intentionally trigger a reload each.
- **Delete handler success path must not re-enable the button** before `loadWatchlist()` repaints — re-enabling early reopens the double-click window the disable exists to close.
- **`#watchlistNotice` is shared state:** `loadWatchlist()` rewrites it (email-config messaging) on every successful load. That's the desired behavior — a delete error shows until the next successful action clears it — but don't "fix" that by adding a separate error element; reuse the existing one per the brief's constraint.

## Out of scope — do not build

- **No change to the ongoing auto-remove-on-verify behavior** (`885b272`, lives in `src/watcher.js`): the strict `verified === true && titleMatch === true` removal rule stays exactly as is.
- **No change to radar expiry logic** (`src/lists.js`, `expiredListWatches`, the 8-week TTL, the status flip to `expired`). The cleanup deletes entries *already marked* expired; it does not change how entries become expired, and future `expired`/`paused`/`fulfilled` entries will **not** be auto-deleted — that's by design.
- **No general concurrency/locking overhaul** — no lock files, no database, no write queue. The write hardening is scoped to surviving the EXDEV fallback safely.
- **No scheduled/recurring sweep job** for non-active watches, in any form.
- **No changes to `MAX_WATCHES`/`LIST_MAX_ACTIVE` caps, no functional changes to Pause/Resume/Check-now** (only the optional one-line disable in Task 5), **no changes to `src/server.js` routes, no new admin endpoints, no container rebuild as part of this work.**
