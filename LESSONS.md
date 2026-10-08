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
