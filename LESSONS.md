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
