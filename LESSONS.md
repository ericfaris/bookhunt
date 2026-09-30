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
