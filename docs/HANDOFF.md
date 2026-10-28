# BookHunt — handoff

## What it is / where it runs
Personal web app that searches the Mobilism ebook forum (headed Chromium via Playwright, under Xvfb), downloads ePUBs via the premium downloader, stores them in Cloudflare R2, and sends them to people's Kindles / inboxes. Also: a watchlist that re-checks searches, a new-release "radar" (NYT/Amazon/Goodreads lists → auto-watch), and a passwordless reader portal at `/reader`.

- Live: `https://bookhunt.mooseflip.com`, Docker container `bookhunt-app-1` on this machine (`127.0.0.1:3000`), exposed by the lab Cloudflare Tunnel, gated by Cloudflare Access (origin verifies the Access JWT). `/reader/*` is the one path with an Access bypass app (token-gated instead).
- `/warm` proxies noVNC to the in-container browser to clear an interactive Cloudflare challenge (autowarm emails when that's needed).

## Commands
- Tests: `npm test` (sets `STORAGE=local DATA_STORE=file`, temp store files — never touches live JSON).
- Rebuild/deploy: `npm run docker:up` (stamps version/commit/build time). Use the `deploy` skill. Add `--pull` (`docker compose build --pull`) when bumping the base image.
- Local smoke run: `PORT=3999 STORAGE=local DATA_STORE=file WATCH_ENABLED=false LISTS_ENABLED=false node src/server.js` with `*_FILE` env vars pointed at copies. **Stop it by PID, not `pkill -f "node src/server.js"`**: that pattern also kills the prod container's process.

## Config not in git (`.env`, names only)
MOBILISM_USER/PASS, MOBILISM_PREMIUM_USER/PASS, CF_ACCESS_TEAM_DOMAIN/AUD/ALLOWED_EMAILS, SMTP_HOST/PORT/USER/PASS/FROM, STORAGE=r2 + R2_* credentials, DATA_STORE=mongo + MONGODB_URI/DB (Atlas user `bookhunt-rw`), optional GOOGLE_BOOKS_API_KEY, NYT key for the radar. Tunables: `DETAIL_CACHE_TTL_MS` (topic cache, default 20 min, 0 = off), `HISTORY_KEEP_PER_TYPE` (default 300 search / watch-hit entries).

## Shared-system wiring
- Cloudflare: tunnel ingress + DNS for bookhunt.mooseflip.com; Access app for the site + a bypass app for `/reader`. Token: `~/.config/cloudflare/mooseflip.token` (`cloudflare` skill).
- R2 bucket `bookhunt-library` holds ALL books (no local copy). App JSON stores mirror to Atlas db `bookhunt`, collection `stores`.
- Sentinel scans the repo; Renovate opens dependency PRs (Dependency Dashboard issues #40/#67).

## Code map (after the 2026-10-25 review pass)
- `src/server.js` — bootstrap, middleware, `/warm`, statics. Routes in `src/routes/{reader,forum,watchlist,library,recipients,ops}.js`, helpers in `src/routes/http.js` (`requireReader`, `sendError`). Versioned page HTML in `src/assets.js`.
- Sending: `src/delivery.js` (attachment fetch-once, Kindle push, meta fill, email cover), used by `/api/send`, the watcher and the reader send.
- Email look: `src/notify/emailkit.js`. Reader email templates: `src/reader-emails.js`.
- Caches (all in memory): topic details (`searcher`), spell-correct candidates (`correct`), covers lookup cache (`covers`, flushed to `covers-cache.json`), Library build (`library.currentBooks`, keyed on `history.signature()`).

## Open items / next steps
1. Review pass (PR #76) is live since 2026-10-25 (commit 36a500c). Library, covers (348/348) and search are verified live. Still unexercised live: the R2 send path through `src/delivery.js`. Watch the next real Send / watcher delivery.
2. Issue #35 (Mongo as primary store) is effectively done via the Atlas mirror; close or re-scope it.
3. `src/reupload.js` forum-control selectors are still guesswork; tune them from logs if outcomes look wrong.
4. Consider adding eslint (`no-unused-vars`, `no-undef`) to `npm test`. A throwaway run caught real dead code during the refactor.

5. 2026-10-27: request threads are now handled. Links are read from every post, and reply premium links are used when the opening post has none. Premium-icon detection now actually flags links; before, every link came back non-premium. Watch the next few watcher runs for unexpected mirror selection: `selectPremiumLinks` now filters to flagged links where it used to fall back to all of them.

6. 2026-10-27 design critique (`/impeccable critique`, snapshots in `.impeccable/critique/`, untracked). All four P1s are fixed on main (reader books-first + honest send flow, Watchlist closes watches for owned books, AA contrast tokens, self-hosted Nunito). **Not yet deployed** when this was written; check `git log` against the running version. Deferred P2s: Watchlist/Readers button density (move Pause/Remove into More▾), labelled + focus-visible Library tile actions (no bare 📧🗑✎), mapping raw downloader errors to plain reasons, and a quieter tile Send on the reader. Re-run `/impeccable critique` after (baseline: admin 26/40, reader 24/40).

## Decisions that may get revisited
- Topic-cache TTL is 20 min: long enough for search → download, short enough for updated set threads. The watcher's re-check interval is longer, so watch re-checks still scrape fresh.
- History prunes only `search` / `watch-hit` entries (History view only); downloads, sends and re-uploads are kept forever.

## Gotchas
- "no verified ePUB in N results" with no errors means 0 mirrors were found, not a wrong book. Inspect the real thread DOM via a copied browser profile (see LESSONS 2026-10-27).
- A stale open tab can run old `app.js` after a deploy; assets are content-hashed (`?v=`) but ask for a hard refresh first.
- `prefillFromQuery()` must stay at the bottom of `public/app.js` (TDZ).
- `public/reader.js` top-level helpers read by the async IIFE (`SENT_HELP`, `spotlightShownThisVisit`) are `var`, not `const`/`let`: the IIFE starts before those lines run, so a `let` there would hit the TDZ.
- Colors: never put a label on `--accent` or use it as a text color. Fills take `--accent-fill` + `--on-accent`, and orange text takes `--accent-ink`. `test/contrast.test.js` enforces AA for both stylesheets.
- Reader-page assets (JS, icons, fonts) must be served under `/reader/*`; anything else sits behind Cloudflare Access, which readers can't pass.
- Single-file bind mounts: never rename over a store file (datastore writes in place after verifying a tmp copy).
