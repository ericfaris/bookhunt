# Lessons

- 2026-09-19: After deploying a frontend fix, an already-open tab can keep
  running the old `app.js` even though the SW is network-first for the shell
  — network-first only helps on the *next* navigation/fetch, not a tab that's
  already loaded and just sitting there. A "still seeing the bug" report
  right after a deploy is often just this — ask for a hard refresh
  (Ctrl+Shift+R) before assuming the fix didn't ship. Confirmed here by
  `docker exec`-grepping the deployed container's `public/app.js` for the fix
  before concluding it was a stale-tab issue, not a bad deploy.

## 2026-09-30 — Logo replaced (open book + magnifier → "Ribbon")
- Old mark had ~5 ideas in 64 px and collapsed at 16 px; new mark is two solid `currentColor` book halves split by a gap + orange ribbon. The gap (not a bg-colored stroke) is what separates ribbon from book, so it needs no background token and works in dark mode.
- Logo lives in 5 places: `favicon.svg`, `reader-icon.svg` (+ 3 PNGs), inline SVG ×2 in `index.html`, ×2 in `design-showcase.html`. `test/brand.test.js` pins them to one ribbon path; re-render PNGs from `reader-icon.svg` when it changes.
- No cairosvg/rsvg/ImageMagick here: rasterize SVG with Playwright by inlining the `<svg>` into `setContent` (an `<img src=file://>` from about:blank is blocked and silently renders a broken image).
- Bump the `sw.js` CACHE version on any shell asset change or the old favicon/mark sticks.

## 2026-10-02 — R2 book storage (#47)
- `src/storage.js` keeps book identity as the logical `/downloads/<file>` savePath and maps it to `books/<basename>` internally, so history/booktags never change and rollback is a flag flip. Existence in r2 mode comes from an in-memory index (one paginated ListObjectsV2), keeping `buildLibrary`'s sync `fileExists` sync.
- Gotcha: adding *any* `await` at the top of `reader.booksForReaderPage` broke `test/reader-buildbooks.test.js` "tags attach" — it stubs `booktags.readStore` in a SYNC wrapper that restores before the first microtask. Reader entry points only await `ensureIndex()` in r2 mode (`ensureStorageIndex()` returns null locally).
- Gotcha: `/api/library` already had a `const store = booktags.readStore()` — name the driver something else (`bookStore`) in that handler.
- `npm test` pins `STORAGE=local`; `.env` holds real R2 creds and server.js loads dotenv, so never let a test read `R2_*` — inject `test/fake-s3.js` via `storage._setDriver`.
- Startup fail-fast is tested by spawning `src/server.js` from a temp cwd (dotenv then finds no `.env`) with a minimal env.

## 2026-10-08 — Watches "found" but never downloaded
- `fulfilled` used to be terminal for ANY hit, including ones that didn't download, so a transient download outage (2026-10-07: 9 hits, 0 downloads; fixed by the next container restart) stranded books forever. Now a no-download hit stays `active` with `downloadMisses` + `retryAfter` (1d/2d/4d/7d…, cap `WATCH_MAX_DOWNLOAD_MISSES`=6) and only then settles as fulfilled. Re-resuming the 13 stranded watches downloaded the outage-day ones on the first try.
- The failure reason is now persisted (`lastError`, history `reason`) — the container's logs vanish on every rebuild, so before this there was no way to tell *why* a past hit didn't download.
- N (`WATCH_OUTAGE_THRESHOLD`=5) consecutive no-download hits email the operator once. Watcher tests stub `smtp` in `withMocks` — `.env` has live SMTP creds.
- Goodreads lists franchise continuations as "Vince Flynn: <title>"; `cleanTitle` keeps the part before the colon, so the radar watched for "Vince Flynn". Fixed with a brand-prefix allowlist (a generic "Name Name: X" rule would break real subtitles like "Atomic Habits: …").
- Retrying a watch from the CLI: `cloudflared access token --app=https://bookhunt.mooseflip.com` → `Cf-Access-Jwt-Assertion` header against `http://127.0.0.1:3000` (skips the tunnel's 100s timeout); `POST /api/watchlist/:id/status {"status":"active"}` then `/check`.

## 2026-10-15 — Reader shelf tap-a-book modal + announcement email
- Native `<dialog>` + `showModal()` gives Esc and focus trapping for free. For click-outside-to-close, make the visible card an inner element that fills the dialog box (dialog `padding:0`, transparent bg); then `e.target === dialog` only happens on the backdrop.
- The tile is now the modal trigger, so the Send button must `stopPropagation()`. Tile and modal Send buttons share `wireSend()` and mutate the same `b.sent` object to stay in sync.
- `spotlightFeature()` now returns a dismiss fn and takes `bubbleAt` (the callout goes before the grid, not inside it as a grid item). The feature dismisses its own tip on first use.
- Pre-existing bug: `.install { display:flex }` beat the `[hidden]` attribute, so the install hint showed as an empty pill when no install event fired (e.g. desktop). Any class that sets `display` needs a `[hidden]{display:none}` override (same as `.search`).
- Running a single test file with bare `node --test` loads `.env` → `STORAGE=r2` → a real (read-only) R2 index list. Always run `STORAGE=local node --test ...`.
- One-off reader emails: dry run by default, per-recipient stamp written right after each send (fresh mutate), failures left unstamped so a re-run retries them. Preview HTML uses a placeholder token so no real magic link lands in /tmp.
- Scripts that WRITE a bind-mounted single-file store (recipients.json etc.) must run inside the container. On the host, writeJsonAtomic's rename succeeds and swaps the inode, so the container keeps the stale file. That's why `scripts/` now ships in the image.
- Cloudflare's Browser Cache TTL rewrites static-looking responses (`/reader/app.js` → `max-age=14400`) despite origin `no-cache`; HTML passes through as DYNAMIC. A deploy then pairs new HTML with a stale script for hours on phones. `/reader` now stamps `app.js?v=<sha256 of reader.js>`. Verify UI changes through the public hostname, not just localhost:3000. Same fix applied to the operator shell (`/` → versioned app.js/style.css) via the shared `stampAssets()` helper; `test/cache-bust.test.js` fails if a page gains an unversioned local script/stylesheet.
- Deploy conflict ("container name /<id>_bookhunt-app-1 is already in use"): pushing to main already deploys (CI `deploy` job → Sentinel `/api/deploy`, under Sentinel's per-repo lock). Running `npm run docker:up` right after a push bypasses that lock and races it. Whichever run loses errors out (one CI deploy failed this way). After a push, watch the CI run instead of deploying by hand.
- Sentinel deploys used to leave `GIT_SHA`/`BUILD_TIME` blank (Settings → Version showed no commit). Fixed in sentinel c4a17c1: every Sentinel deploy now stamps them.

## 2026-10-16 — Cover image store + wider source chain
- Covers used to be URL-only: covers-cache.json held the URL, and every browser hot-linked Open Library/Google on every render. Now `src/coverstore.js` resolves once (stored URL → EPUB cover → catalogs → generated SVG), saves to `cover-images/`, and all UIs load from `/cover-image/*` or `/reader/cover`.
- A probe of the 79 cached misses: Apple Books (iTunes Search, keyless) found ~half. Google returned 429 to every keyless request; the old code cached ANY failure as a 7-day "no cover". Fixed: `fetchJson` retries transient errors; failure-caused misses carry `transient` and a 1h TTL; `CACHE_VERSION` re-tries misses from the old chain once.
- 6/6 sampled real EPUBs had an embedded cover (EPUB3 `cover-image` / EPUB2 `<meta name="cover">` / guide page / "cover"-named item). Some are 3+ MB; there's no image-resize lib in the image, so they're served as-is.
- On the host, `.env` has an empty `DOWNLOAD_PATH`, so every book reads `filePresent:false` under r2. The container sets `/downloads`. Set `DOWNLOAD_PATH=/downloads` when running library scripts on the host.
- `/reader/cover` is registered BEFORE the `/reader` 40/min limiter (a shelf page loads ~24 images), with its own 600/min limit.
- Email covers skip the EPUB step (`epub:false`): it would read the book a second time on top of the Kindle attachment, and r2 send tests pin exactly one GetObject.
- 2026-10-16: removed the one-time Goodreads Most Read backfill (finished Aug 2026: 88 watched). Route, Settings button, radar drain step, and digest section are gone; `lists.readState()` drops the legacy `backfill` key. The Most Read list stays a live-radar source, and the 18 watches it created keep their 'Backfill' tag as plain data.

## 2026-10-16 — Admin app → routed pages; reader "shelf" → Library
- Product direction (from the user): the operator app is an admin only they use (desktop-first, room to breathe); the magic-link `/reader` page is the only reader interface (mobile-first). The people are "Readers", the place is their "Library".
- A live usability pass found Back left the app from every overlay, Recipients overflowed its card (desktop and phone), and the Watchlist was a 360px column on a 1440px screen. The root cause was everything being a phone-sized modal or drawer over the search page. The fix was a hash router + `.page` sections; transient dialogs (send/download/batch/creds) stay modals.
- Keep each screen's render functions and change only their container. Most of the rework was swapping `panel.hidden` toggles for router enter/leave hooks.
- Gotcha: the old History renderer showed `notify` (send) entries as downloads (fell through to the else branch). Activity now renders each type explicitly; `channels:[{channel:'reader'}]` means the reader sent it themselves.
- Gotcha: a full-screen transparent `<dialog>` can't use `e.target === dlg` alone for click-outside; also treat its stage/layout wrappers as empty space. Never call `showModal()` on an already-open dialog (prev/next re-opens): guard with `if (!dlg.open)`.
- Kept internal ids that persist user state (`shelf-search-2026-07` spotlight key, `setupLazyShelf`) unchanged while renaming visible copy. Renaming the key would re-show a dismissed tip.
- Verify UI changes with a harness that requires `src/server` (no schedulers start on require) against temp copies of history/watchlist/recipients, SMTP blanked, `DOWNLOAD_PATH=/downloads`, and a temp `COVER_IMAGE_DIR`.

## 2026-10-16 — sharp for covers; Backfill tag data cleanup; dead CSS
- Added `sharp` (prebuilt binaries work on `node:26-slim`; Playwright's `--with-deps` already installs fonts, so SVG text renders). Covers fit 900×1350 as JPEG q82, and old oversized files are fixed on next read. Generated SVG jackets go to PNG for email, so every email now has a cover.
- `npm install <pkg>` also syncs local `node_modules` to the lockfile, which can move Playwright to a version whose browser isn't downloaded yet. Run `npx playwright install chromium` locally; the image installs its own.
- The Backfill tag lived in `booktags.json` (57 books) and on 18 watches (one active, which would have re-tagged its download). Stripped in-container (bind-mounted single files) after host backups `*.bak-20261016-112413`, then diffed against the backups: only that tag changed. `watchlist.writeAll` isn't exported; use `watchlist.update(id, patch)`.
- Dead-CSS pruning: find unused classes with an exact-token regex (`\b` treats `-` as a boundary, so `watch-recip` "matches" `watch-recip-label`). A naive `selectors{…}` regex swallows the comment before a rule; restore section-header comments afterwards and diff the result.
- After sharp went in, a production check found the mega view showing a 128×198 cover: 180 of 309 stored covers were 128px catalog thumbnails (Google `zoom=1`). Google's `books/content` URLs take `fife=w800-h1200` (800×1200; `zoom=0` gives full size), and `edge=curl` is what draws the fake page curl. The chain is now quality-aware (<400px is a fallback; keep looking: EPUB, then catalogs; else use the widest found), small stored covers get one upgrade attempt per process, and `COVER_REV` in `versionFor` busts the week-long browser cache.

## 2026-10-16 — No native popups; confirm every destructive action
- Native `confirm()`/`prompt()` showed the browser's "bookhunt.mooseflip.com says" box. They're replaced by `askDialog` (`confirmDialog`/`promptDialog`) on `#dialogModal`. `test/dialogs.test.js` bans native popups and requires a confirm before every destructive request. It also counts `method: 'DELETE'`, so a new delete has to be added to its list.
- Gotcha: the focus-trap `MutationObserver` focuses the first focusable *after* the dialog opens, so any `.focus()` you set on open gets overridden. That's why Cancel (not OK) gets default focus on confirms, which is the safe default for destructive ones anyway. To focus something else, reorder the markup.
- The dialog uses `z-index: 80` because it can open from the mega view (35) and lightbox (60).
- The reader footer's "Stop the new-book emails" used to unsubscribe on a single tap. The reader UI has no modal, so it now uses the same inline `.note` Yes/Keep bar as the `?unsub=1` email path.

## 2026-10-16 — House app-icon standard (all *.mooseflip.com apps)
- The standard comes from redline (heat) and jambo. Each app has one bold, dimensional mark on a rich tile. The file set is `favicon.ico` (16/32/48), `apple-touch-icon.png` (180, square), `icon-192/512.png` (rounded, transparent corners) and `icon-maskable-512.png` (mark at 0.8 scale), all listed in the manifest. Every repo got `scripts/icons/{icon.svg,build.py}`. The master has `#bg`, `#mark` and an optional `#mark-small` (favicon-only) layer, and Playwright renders the variants. Python is the only dependency, even in Node repos.
- Detailed marks turn to mush at 16px, so add a `#mark-small` that zooms in or drops detail (slipcast drops its waves, meal-mate drops the platter).
- Before redrawing a project's icon, check it for an existing brand mark (meal-mate's Two Cloches, tools' drafting compass) and render that mark dimensionally instead of inventing a new one.
- Check what else uses the old icon files. vandal-preachers uses `/icon-192.png` as an in-app emblem. That project was skipped at the user's request.
- A service worker that caches icons needs its cache name bumped, or installed copies keep showing the old icons. bookhunt sw v6, study sw v6 and meal-mate's version bump all handle this.
