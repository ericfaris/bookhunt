# Concept brief: mobile hamburger nav for topbar actions

## Problem
The topbar action row (`.topbar-actions` in `public/index.html`) holds six buttons:
Library, 🔔 Watchlist, History, Status, 👥 Recipients, ⚙ Settings. On mobile these
no longer fit. The current mitigation (`public/style.css` `@media (max-width: 520px)`)
just wraps them onto a second row, which is no longer sufficient — buttons still
crowd/overflow on narrow phones. Desktop rendering is correct and must not change.

## Goal
On narrow viewports, replace the visible button row with a single ☰ hamburger
button. Tapping it reveals the same six actions stacked full-width in a
slide-down panel directly beneath the header (pushes page content down, no
overlay/scrim). Tapping a button in the panel performs its existing action
(opens the corresponding modal) and the panel closes. Desktop (>600px) is
visually and behaviorally unchanged.

## In scope
- `public/index.html`: add a hamburger toggle button in `.topbar`, wrap/mark up
  the existing six buttons so they can be shown either as the current inline
  row (desktop) or as a stacked panel (mobile) — reuse the same six `<button>`
  elements and their existing `id`s (`libraryToggle`, `watchlistToggle`,
  `historyToggle`, `statusToggle`, `recipientsToggle`, `settingsToggle`) rather
  than duplicating markup, so existing `app.js` listeners keep working
  unmodified.
- `public/style.css`: new `@media (max-width: 600px)` rules that hide the
  inline `.topbar-actions` row, show the hamburger button, and style the
  slide-down panel (full-width, stacked buttons, opens/closes with a CSS
  transition). Remove/retire the now-superseded `@media (max-width: 520px)`
  wrap-to-second-row rule for `.topbar-actions` (the hamburger replaces it).
  The `@media (max-width: 400px)` tagline-hiding rule can stay as-is (harmless
  either way) but its `.topbar-actions .ghost-btn` padding tweak is moot once
  those buttons live in the panel — fine to leave or drop, executor's call.
- `public/app.js`: hamburger open/close toggle logic (toggle a class on the
  panel/topbar), close the panel on: selecting any action button, clicking
  outside the panel, and pressing Escape. Keep this additive — do not touch
  the six existing `addEventListener('click', open...)` wiring for the action
  buttons themselves.
- Basic accessibility: hamburger button gets `aria-expanded` reflecting panel
  state and an `aria-label` (e.g. "Menu"); panel buttons remain reachable by
  keyboard tab order when open.

## Out of scope
- The search-card secondary button row (☰ Batch / Paste) — not part of this
  change per explicit user decision.
- Any modal content changes (Library, Watchlist, History, Status, Recipients,
  Settings modals themselves are untouched).
- Changing button behavior/handlers — only their container/visibility changes.
- Desktop layout — must remain pixel-identical to current behavior above the
  600px breakpoint.

## Constraints
- Static frontend, no build step: plain HTML/CSS/JS served from `public/`
  (confirmed via `grep` — `app.js` uses `$('#id')` selector helpers and plain
  `addEventListener`, no framework, no bundler).
- Breakpoint: **≤600px** triggers hamburger mode (matches the existing
  `.topbar` sizing breakpoint in `style.css`, chosen over the tighter 520px
  option so the hamburger takes over right where the topbar starts getting
  cramped, rather than only replacing the narrower wrap rule).
- Panel style: slide-down under the header, not a side drawer, no dimmed
  overlay — user's explicit choice.
- Must not break existing desktop UI, which "is rendering beautifully."

## Acceptance criteria
1. At viewport widths >600px, the topbar renders exactly as it does today —
   six inline buttons next to the wordmark, no hamburger visible.
2. At viewport widths ≤600px, the six buttons are not shown inline; instead a
   single ☰ button is visible in the topbar.
3. Tapping ☰ reveals a full-width panel below the header containing all six
   buttons stacked vertically, each clearly tappable (adequate touch target
   size, no overlap/clipping) at widths down to ~320px.
4. Tapping any button in the open panel triggers its existing behavior (e.g.
   Library opens the Library modal) exactly as it does on desktop, and the
   panel closes afterward.
5. Tapping ☰ again while open closes the panel without triggering any action.
6. Tapping outside the panel, or pressing Escape, closes it.
7. No console errors introduced; existing modals (Library, Watchlist, History,
   Status, Recipients, Settings) still open/close correctly from both desktop
   and mobile-panel triggers.
8. Verified via the `webapp-testing` skill (Playwright) at both a desktop
   viewport (e.g. 1280px) and a mobile viewport (e.g. 375px).

## Open questions & decisions made
- Plan review gate: **skipped** — user chose to go straight from plan to
  execution, no approval pause before Phase 4.
- Scope: **topbar row only**, not the search-card Batch/Paste row.
- Menu style: **slide-down panel**, not a side drawer.
- Breakpoint: **≤600px**.

## Relevant files/areas
- `public/index.html` — lines ~18–51 (`<header class="topbar">` through
  `.topbar-actions` buttons).
- `public/style.css` — `.topbar` / `.topbar-actions` rules (~lines 82–95) and
  the responsive block (~lines 1032–1067), specifically the
  `@media (max-width: 520px)` wrap rule to retire and the
  `@media (max-width: 600px)` block to extend.
- `public/app.js` — existing listeners at lines 1387, 1655, 1920, 1982, 2586,
  2721 (`recipientsToggle`, `settingsToggle`, `statusToggle`, `libraryToggle`,
  `historyToggle`, `watchlistToggle`) — do not modify these bindings, only add
  new hamburger toggle/close logic alongside them.

## Repo commands & tree state
- No build step / package manager test suite found for the frontend; this is
  a static `public/` folder served by the app (see
  `bookhunt-runtime` memory for how the app runs locally — headed browser via
  WSLg/DISPLAY, Cloudflare Tunnel/Access). Verification is manual/visual via
  the `webapp-testing` (Playwright) skill against the running dev instance,
  not an automated test command.
- `npm run docker:up` is the project's rebuild/restart command (stamps
  version/commit/build-time) if a container rebuild is needed to see changes
  live — confirm with the user before running, per deploy gating later in
  this lifecycle.
- Git tree state at brief time: **clean**, but local `main` is 1 commit ahead
  of `origin/main` (unpushed prior commit, unrelated to this work) — the
  executor should not assume a synced remote and should not push anything
  itself.
