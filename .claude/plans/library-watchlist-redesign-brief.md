# Concept brief: Library & Watchlist row redesign

## Problem

The Library panel's list-view rows and the Watchlist modal's rows both feel
"very tight and crammed." A full design review (Fable) diagnosed the root
causes and proposed a concrete redesign — see
`.claude/plans/library-watchlist-uiux-review.md` for the full diagnosis and
proposal. This brief distills that review plus the user's decisions on its
open questions into a build-ready spec.

## Goal

Restructure the Library list row (`.lib-book`, rendered by
`renderLibraryBook()`) and the Watchlist row (`.watch-row`, rendered by
`renderWatchlist()`/`watchStatusBadge()`) to use progressive disclosure —
2-3 visual strata at rest instead of 7 — while keeping the app's existing
compact rem-based spacing scale and color/radius tokens. Fix the badge-gap
bug along the way. No new visual language; converge these rows onto the
same card language already used by search results (`.card`) and the
library grid tiles (`.lib-tile`), which the review identifies as the
target quality bar.

## In scope

Everything in review doc §2 ("Design proposal") and §3 ("What
stays/changes"), specifically:

**Library list row:**
- Restructure `.lib-book` to a 3-column grid: `72px cover | main content | action cluster`.
- Merge badges + meta + tags into one `.lib-metaline` (drop 📦/📅 emoji, keep badge/tag pills).
- Replace always-expanded send history with a one-line `.lib-send-summary` + disclosure chevron that reveals the existing `renderSend()` rows inside a `.lib-drawer`.
- **Filename: moves into the expand drawer, hidden at rest** (user decision — not a tooltip, not dropped).
- **Send history: always starts collapsed** (user decision — no auto-expand for single-send books).
- Kill `.lib-resend { width: 100% }`; replace with a compact send button + icon-only 🗑 delete in the new action cluster (top-right, third grid column).
- Checkbox (`.lib-select`) becomes hover-revealed (and `opacity:1` under `@media (hover: none)` for touch), matching `.lib-tile-select`'s existing pattern.
- Cover grows 64×96 → 72×108.
- New `@media (max-width: 440px)` rule stacking the action cluster to a footer row, cover shrinks to 56×84.
- Row padding, gap, radius, shadow unify onto `.card`'s existing values (14px radius, `--shadow-sm`, hover lift) — see review §2.1 and §2.3 for exact numbers.
- **No third density toggle** — the one list view is redesigned in place (user decision); grid view (`.lib-grid`/`.lib-tile*`) is untouched.

**Watchlist row:**
- Fix the badge-cluster bug: `watchStatusBadge()` (app.js:2638) gets a classed `.watch-badges` wrapper (`display:inline-flex; gap:0.35rem`) instead of a bare unclassed span.
- Make `.watch-row`'s grid actually responsive: add `@media (max-width: 480px)` shrinking the cover column and moving `.watch-actions` to a full-width grid row. Requires `.watch-actions` to become a direct grid child (move it out of `.watch-row-main` in `renderWatchlist()`).
- Delete the dead duplicate `@media (max-width: 520px) { .watch-form { grid-template-columns: 1fr } }` block (style.css ~462-464).
- `.watch-head` gets `flex-wrap: wrap` so long titles push badges to a second line instead of crushing them.
- Split `.watch-meta` into a status line (checked date/count, or a proper `--warn`-colored error chip) and a delivery line (open-match link + sent/Kindle counts) — only rendered when applicable, not mixed into one wrapping flexbox.
- **Pause/Resume and Remove become icon-only (⏸/▶/🗑) everywhere** (user decision — not just under the mobile breakpoint), with `title` tooltips and `aria-label`s for accessibility. The one contextual action (`Check now` / `Watch again`) stays as a text button.
- Recipient line/editor gets a defined inset panel style (border, padding, radius) instead of "spilled checkboxes."
- **Widen `.watchlist-card` from 560px to 640px** (user decision), bump `.watchlist-body` max-height to 62vh.
- When recipient list > 3, collapse the add-form recipient strip behind a disclosure so the add-watch form stays two lines tall.
- Row padding/gap/radius unify onto the same 14px-radius, shadow-lifted card language as the Library row.

**Shared:**
- Adopt the spacing recipe in review §2.3 (stratum gap 0.2-0.35rem within a group, group gap 0.55-0.7rem between concerns, row padding 0.9-1.1rem, row gap 0.75-1rem) for both components.
- Zero new CSS custom properties/tokens — reuse `--surface(-2)`, `--border(-strong)`, `--text(-dim)`, `--accent`, `--good/--warn/--danger`, `--radius/--radius-sm`, `--shadow-sm/--shadow`, `--ease`, `--font-rounded`, and the existing `color-mix(...)` chip recipe for the new warn/error chips. This means no dark-mode-specific overrides should be needed — verify visually in both light and dark.

## Out of scope

- Library grid view (`.lib-grid`, `.lib-tile*`, `renderLibraryGridCard()`) — already the target quality bar per the review, leave untouched.
- Cover-fetching machinery (`renderLibraryCover()`, `buildEditableCover()`, `buildWatchCover()`, IntersectionObserver lazy-load, lightbox) — unchanged, only the surrounding layout changes.
- All API calls/handlers in `renderLibraryBook()`/`renderWatchlist()` — this is DOM re-layering of the same data, not a data or backend change.
- Any change to `src/watcher.js`, `src/watchlist.js`, `src/library.js`, or any backend/API route — this is a pure frontend (`public/index.html`, `public/app.js`, `public/style.css`) change.
- `.watch-form`'s existing 520px stacking rule for the *add-watch form* (title/author/submit) — already works, don't touch (only the dead duplicate block gets deleted).
- No new interaction idioms — hover-reveal and disclosure patterns must copy existing ones already in the codebase (`.lib-tile-select`, `.watch-recip-editor`'s show/hide).
- Docker rebuild/deploy — code + manual verification only; the operator (Eric) decides when to rebuild/deploy separately.

## Constraints

- Pure frontend change: `public/index.html`, `public/app.js`, `public/style.css` only.
- Must preserve every existing data point currently shown (nothing is removed from the *product*, only re-organized between "at rest" and "behind disclosure") — see review §3 for the exact DOM/CSS diff inventory.
- Must work in both light and dark mode (`@media (prefers-color-scheme: dark)` — verify, don't just assume token reuse is sufficient).
- Must not regress existing functionality: multi-select/bulk actions (`#libActionBar`), tag filtering (`#libTagBar`), search/filter (`#librarySearch`), recipient editing, "Check now"/pause/resume/remove watch actions, re-download for missing files.
- No test suite covers frontend DOM/CSS (per prior exploration, `test/*.test.js` is backend-only) — verification here is manual browser testing, not `npm test`.

## Acceptance criteria

1. A Library list row at rest shows: cover (72×108), title, author, one merged metaline (badges/verified/size/date/tags, no emoji), one send-summary line — filename is NOT visible at rest.
2. Clicking the send-summary's disclosure chevron reveals filename + full per-send history in a drawer; collapses again on a second click/toggle.
3. The Library row's action cluster is a compact button + icon-only delete in the top-right, not a full-width button; the multi-select checkbox is hidden until hover (or always visible on touch devices, `@media (hover: none)`).
4. `.lib-book`, `.watch-row` visually match `.card`'s radius (14px) and shadow treatment; row-to-row gaps are visibly larger than each row's internal padding.
5. Resizing the browser below ~480px causes Watchlist rows to reflow (not overflow/clip) — the cover shrinks and action buttons move to their own row.
6. The status + "📈 List" badge pair in the Watchlist row render with visible spacing between them (bug fix verified).
7. Pause/Resume/Remove on watch rows render as icon-only buttons with tooltips (hover shows text) at all viewport widths.
8. The Watchlist modal renders at up to 640px wide (not 560px) on desktop.
9. No regressions: bulk-select, tag filtering, search, recipient add/edit, check-now, re-download-missing-file all still function exactly as before in a manual click-through.
10. Verified in both light and dark OS theme (toggle via OS setting or devtools emulation).

## Open questions & decisions made

All of Fable's review open questions are resolved:
1. **List density:** no third compact/comfy toggle — redesign the one list view in place.
2. **Filename placement:** moves into the expand drawer at rest (not tooltip, not dropped).
3. **Icon-only watch actions:** icon-only (⏸/▶/🗑) everywhere, not just under the mobile breakpoint.
4. **Send history default:** always starts collapsed, no auto-expand for single-send books.
5. **Watchlist modal width:** widen 560px → 640px.
6. **Tags at rest:** stay on the metaline as pills; the `✎ Tags` edit button moves into the drawer (per the review's baseline proposal — user did not object).

**Confirmation gate for this run:** the user opted to **skip** the Phase 3
plan-review gate again for this feature — Fable's implementation plan
should be sanity-checked by the orchestrating (Sonnet) session and then
passed straight to Opus for execution without pausing for user approval,
unless the sanity-check turns up something seriously wrong. Given this is a
visual/UX change, the orchestrating session should pay extra attention
during sanity-check to whether the plan's described layout genuinely
resolves the "crammed" complaint, and should ask Opus to report/screenshot
its work if the `run` or `webapp-testing` tooling is available, since there
is no automated test coverage for frontend layout.

## Relevant files/areas

- `public/index.html:122-140` (Library panel shell), `:170-189` (Watchlist modal shell).
- `public/app.js`: `renderLibrary()`, `renderLibraryBook()`, `renderLibraryGridCard()`, `renderLibraryCover()` (~lines 2126-2317); `renderSend()` (~2398-2410); `renderWatchlist()`, `watchStatusBadge()`, `buildWatchCover()` (~2627-2774).
- `public/style.css`: tokens (1-60), `.card` (267-283/304-347 area), watchlist rules (426-464), library drawer + row rules (481-686), library management/tags (1123-1154).
- Full diagnosis and proposed CSS/DOM values: `.claude/plans/library-watchlist-uiux-review.md` (read this in full — it has exact selectors, rem values, and rationale for every change listed above).

## Repo commands & tree state

- **No test suite for frontend** — `npm test` (`node --test test/*.test.js`) covers only backend logic and will not exercise this change; do not rely on it for verification.
- **Run locally:** `npm start` (`node src/server.js`) or `npm run dev` (`node --watch src/server.js`). Requires headed browser / WSLg display per project memory to visually verify in-browser; the `run` and `webapp-testing` skills are available for automated browser verification/screenshots if the environment allows.
- **No build step** — plain Node/vanilla JS/CSS, no bundler, no transpile.
- **Working tree:** was clean on `main` as of the previous feature's brief; the prior watchlist-auto-remove feature build left uncommitted changes in `src/watcher.js`, `src/watchlist.js`, `test/watcher.test.js`, `test/watchlist.test.js`, `package.json` (version bump). The executor should be told these are pre-existing, unrelated changes from a separate completed feature — not to be touched, reverted, or attributed to this task. Re-run `git status` at the start of execution to confirm current state before branching/committing.
