# Implementation plan: mobile hamburger nav for topbar actions

## Summary
The topbar action row (`.topbar-actions`) holds six `<button>`s (Library, 🔔 Watchlist,
History, Status, 👥 Recipients, ⚙ Settings). On narrow phones they crowd/overflow; the
current mitigation (a `@media (max-width: 520px)` rule that wraps them onto a second row)
is no longer good enough. This change adds a single ☰ hamburger button that is visible
only at ≤600px. Tapping it slides down a full-width panel below the sticky header
containing the same six buttons stacked vertically; tapping any of them runs its existing
handler (opens the matching modal) and closes the panel. The panel also closes on a second
tap of ☰, on a click outside, and on Escape. Desktop (>600px) rendering and behavior are
unchanged. The key implementation trick: **reuse the existing `.topbar-actions` container
and its six buttons in place** (no duplicated markup, no changes to the six existing
`addEventListener` bindings) — only CSS restyles that container into a stacked panel at
≤600px, and a small additive JS block toggles a `nav-open` class.

## Approach & key decisions
- **Reuse `.topbar-actions` as the mobile panel; do not duplicate the buttons.** The six
  buttons keep their existing `id`s (`libraryToggle`, `watchlistToggle`, `historyToggle`,
  `statusToggle`, `recipientsToggle`, `settingsToggle`) so every existing listener in
  `app.js` keeps working with zero edits. At ≤600px, CSS turns `.topbar-actions` from a
  horizontal inline row into a full-width vertical stack that lives on its own row below
  the brand. This avoids any risk of desynchronizing two copies of the same controls.
  - *Rejected:* building a second `<nav>` with cloned buttons + new handlers — more markup,
    duplicate wiring, and a real chance of breaking the "existing modals still open"
    acceptance criterion.
- **Slide-down via `.topbar-actions` inside the sticky header (no scrim/overlay).** The
  `.topbar` is `position: sticky; top: 0; z-index: 10` (style.css:82-93). Because the panel
  is a child of the sticky header, expanding it grows the header and naturally pushes page
  content down — exactly the "pushes page content down, no overlay" behavior the brief
  wants — with no extra positioning math.
  - *Rejected:* an absolutely-positioned dropdown or a `position: fixed` side drawer —
    would overlay content (against the brief) and need scrim/scroll-lock handling.
- **Animate with `max-height` + `visibility`, not `display`.** `display: none` can't
  transition. Collapsed state = `max-height: 0; overflow: hidden; visibility: hidden`
  (visibility keeps the buttons out of the tab order while closed); open state
  (`.topbar.nav-open`) = a generous `max-height` + `visibility: visible`, giving a clean
  slide-down. A reduced-motion guard disables the transition.
- **Toggle a `nav-open` class on `.topbar`.** Single source of truth for panel state; the
  hamburger's `aria-expanded` is set from it. Chosen over toggling a class on the panel so
  the media query can also key sibling styling (e.g. hamburger active state) off one hook.
- **Breakpoint ≤600px**, matching the existing `.topbar` sizing breakpoint at
  style.css:1033, per the brief. The old `@media (max-width: 520px)` wrap block is retired
  (it only ever styled the topbar and now conflicts with the hamburger layout).
- **Reuse existing visual vocabulary:** the hamburger uses the existing `.ghost-btn` class
  (style.css:188-200) so it inherits border, radius (`--radius-sm`), padding, hover/active,
  and focus-visible ring for free. Panel buttons are already `.ghost-btn`; the media query
  only overrides their width/justification/touch height. Colors use existing CSS variables
  (`--surface`, `--border`, `--shadow`) — no new design tokens.

## Files changed
- `public/index.html` — add one hamburger `<button>` inside `.topbar`.
- `public/style.css` — retire the 520px block; extend the ≤600px block with hamburger +
  panel rules; add a default (desktop) `display: none` for the hamburger.
- `public/app.js` — add one small additive block (open/close/toggle + outside-click) and
  one line in the existing Escape handler.

No other files. No new files.

## Step-by-step tasks

### 1. HTML: add the hamburger button (`public/index.html`)
In the `<header class="topbar">` block (lines 18-51), insert a hamburger button as a
**sibling of `.topbar-actions`**, immediately before the `<div class="topbar-actions">` at
line 43 (so DOM order is: brand `h1`, hamburger, actions panel):

```html
    <button id="navToggle" class="nav-toggle ghost-btn" type="button"
            aria-label="Menu" aria-expanded="false" aria-controls="topbarActions">☰</button>
    <div class="topbar-actions" id="topbarActions">
```

- Add `id="topbarActions"` to the existing `.topbar-actions` div (line 43) so
  `aria-controls` has a target and JS can select it cleanly.
- Do **not** touch the six existing buttons (lines 44-49) — leave their `id`s, classes,
  titles, and text exactly as-is.

Verify independently: page still loads; at desktop width the new button is invisible
(styled `display:none` in step 3) and the six buttons render inline as before.

### 2. CSS: hide the hamburger by default (desktop) (`public/style.css`)
Near the topbar rules (after `.topbar-actions` at style.css:95) add the default desktop
state so the hamburger is hidden above the breakpoint:

```css
.nav-toggle { display: none; font-size: 1.15rem; line-height: 1; padding: 0.42rem 0.7rem; }
```

Verify: at >600px nothing visually changes (button hidden).

### 3. CSS: retire the old 520px wrap block (`public/style.css`)
Delete the entire block at style.css:1054-1060:

```css
/* Narrow phones: let the action buttons wrap to their own row ... */
@media (max-width: 520px) {
  .topbar { flex-wrap: wrap; row-gap: 0.5rem; }
  .topbar h1 { flex: 1 1 100%; }
  .topbar-actions { flex: 1 1 100%; }
}
```

Reason: it forces the brand `h1` to 100% width and wraps the raw button row — both
conflict with the hamburger layout (we want brand + ☰ on the same first row). The
hamburger replaces this behavior entirely.

Leave the `@media (max-width: 400px)` block (style.css:1064-1067) in place; its
`.topbar-actions .ghost-btn { padding: 0.4rem 0.6rem; }` is harmless inside the panel and
the tagline-hide is still wanted.

### 4. CSS: hamburger + slide-down panel rules (`public/style.css`)
Extend the existing `@media (max-width: 600px)` block (style.css:1033-1052). Inside that
block, add:

```css
  /* Topbar collapses to a hamburger; brand + ☰ share the first row, the six
     action buttons become a full-width slide-down panel on their own row. */
  .topbar { flex-wrap: wrap; row-gap: 0; }
  .topbar h1 { flex: 1 1 auto; }          /* brand keeps the row with the ☰ */
  .nav-toggle { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; }

  .topbar-actions {
    flex: 1 1 100%;                        /* own row, full width */
    flex-direction: column;
    gap: 0.4rem;
    max-height: 0;
    overflow: hidden;
    visibility: hidden;                    /* keep buttons out of tab order while closed */
    transition: max-height var(--ease), margin-top var(--ease), visibility var(--ease);
    margin-top: 0;
  }
  .topbar.nav-open .topbar-actions {
    max-height: 60vh;                      /* generous; six buttons never exceed this */
    visibility: visible;
    margin-top: 0.6rem;
    overflow-y: auto;                      /* safety net on very short screens */
  }
  .topbar-actions .ghost-btn {
    width: 100%;
    text-align: left;
    justify-content: flex-start;
    padding: 0.7rem 0.85rem;               /* ~44px touch target */
    font-size: 0.95rem;
  }
  .topbar.nav-open .nav-toggle { border-color: var(--accent); }
```

Notes / rationale:
- `row-gap: 0` on `.topbar` plus `margin-top` on the open panel keeps the header tight when
  the panel is closed and adds breathing room only when open.
- The panel inherits the header's translucent background/blur (it's inside `.topbar`), so
  it reads as a continuation of the header without new surface styling. If it looks too
  transparent over content while scrolled, optionally add
  `.topbar.nav-open { background: var(--surface); }` — but try without first to keep the
  design minimal.
- Reduced motion: add outside/after this block (near the existing
  `@media (prefers-reduced-motion: reduce)` at style.css:1008):
  ```css
  @media (prefers-reduced-motion: reduce) {
    .topbar-actions { transition: none; }
  }
  ```

Verify at 375px: with `nav-open` toggled by hand in devtools, panel shows six stacked
full-width buttons; without it, panel is collapsed and the ☰ is the only visible control.

### 5. JS: hamburger open/close logic (`public/app.js`)
Add a small **additive** block. Place it near the end of the file but **before** the final
`prefillFromQuery();` call at app.js:3511 (that call must stay last for TDZ reasons — see
Risks). A good spot is just before the "Global keyboard: Escape…" handler at app.js:3489.

```js
// ---------------------------------------------------------------------------
// Mobile hamburger nav: the six topbar action buttons collapse into a
// slide-down panel at <=600px. Toggling a class on .topbar is the single
// source of truth; the buttons' own click handlers are untouched.
// ---------------------------------------------------------------------------
const topbar = $('.topbar');
const navToggle = $('#navToggle');
const topbarActions = $('#topbarActions');

function openNav() {
  topbar.classList.add('nav-open');
  navToggle.setAttribute('aria-expanded', 'true');
}
function closeNav() {
  topbar.classList.remove('nav-open');
  navToggle.setAttribute('aria-expanded', 'false');
}
function toggleNav() {
  topbar.classList.contains('nav-open') ? closeNav() : openNav();
}

navToggle.addEventListener('click', (e) => { e.stopPropagation(); toggleNav(); });

// Selecting any action closes the panel (its own handler still runs and opens
// the modal). Delegated so it never needs to know the six ids.
topbarActions.addEventListener('click', (e) => {
  if (e.target.closest('.ghost-btn')) closeNav();
});

// Click anywhere outside the header closes the panel.
document.addEventListener('click', (e) => {
  if (!topbar.classList.contains('nav-open')) return;
  if (!topbar.contains(e.target)) closeNav();
});
```

- Do **not** modify the six existing bindings at app.js:1387 (`recipientsToggle`), 1655
  (`settingsToggle`), 1920 (`statusToggle`), 1982 (`libraryToggle`), 2586
  (`historyToggle`), 2721 (`watchlistToggle`). The delegated close listener sits alongside
  them and fires independently.
- The `e.stopPropagation()` on the toggle prevents the same click from bubbling to the
  document outside-click handler and immediately re-closing.

### 6. JS: Escape closes the panel (`public/app.js`)
In the existing Escape handler (app.js:3494-3507), add a nav check. Put it right after the
`if (e.key !== 'Escape') return;` guard (line 3495) so an open panel is dismissed first:

```js
  if (e.key !== 'Escape') return;
  if (topbar.classList.contains('nav-open')) return closeNav();
```

This is the only edit to that handler; the modal-dismiss chain below it is unchanged. (On
mobile the panel is never open at the same time as a modal, since opening a modal closes
the panel — so ordering here is safe either way.)

## Data / model / API changes
**None.** This is a pure static-frontend change (HTML/CSS/JS in `public/`). No schemas, no
endpoints, no request/response shapes, no types, no migrations, no server code. The app has
no build step and no bundler — files are served as-is.

## Testing & verification
No automated test suite or build step exists for the frontend. Verify with the
**`webapp-testing` (Playwright)** skill against the running dev instance, at a desktop
viewport (1280px) and a mobile viewport (375px). If the app must be (re)built to serve the
edited files live, that is `npm run docker:up` — **confirm with the user before running it**
(deploy gating); for pure `public/` edits a hard refresh of the already-running instance is
usually enough.

Map each acceptance criterion to a check:

1. **Desktop unchanged (>600px).** At 1280px: six inline buttons next to the wordmark; the
   ☰ button is not visible (`display:none`). Screenshot and compare to current look — no
   layout shift.
2. **≤600px shows only ☰.** At 375px: the six buttons are not visible inline; a single ☰
   sits in the topbar next to the brand.
3. **Panel opens, stacked, tappable down to ~320px.** Tap ☰ → a full-width panel slides
   down below the header with all six buttons stacked vertically, none overlapping/clipped.
   Repeat the check at a 320px viewport. Confirm each button's box height is a comfortable
   touch target (~44px from the `0.7rem` vertical padding).
4. **Panel action runs existing behavior + closes.** With the panel open, tap "Library" →
   the Library modal opens (same as desktop) and the panel is closed behind it. Spot-check a
   second one (e.g. Status) to confirm the delegated close doesn't swallow the handler.
5. **Second ☰ tap closes, no action.** Open, then tap ☰ again → panel closes, no modal
   opens. Confirm `aria-expanded` flips `true`→`false`.
6. **Outside-click and Escape close.** With panel open: click on the page body (outside the
   header) → closes. Reopen, press Escape → closes.
7. **No console errors; modals still work both ways.** Capture browser console during the
   above — no new errors/warnings. Confirm each of the six modals still opens/closes from
   the desktop inline buttons (at 1280px) and from the mobile panel (at 375px).
8. **Both viewports exercised** via Playwright at 1280px and 375px, per above.

Also sanity-check `aria-expanded` toggles correctly and, when the panel is closed, its
buttons are not reachable by keyboard Tab (they're `visibility: hidden`), but are reachable
once open.

## Risks & watch-outs
- **Keep `prefillFromQuery();` as the last statement in app.js** (line 3511). Insert the new
  nav block *above* it (e.g. before line 3489). Appending after it risks a TDZ
  `ReferenceError` per the file's own comment and the `amazon-extension` memory note.
- **Do not edit the six existing `addEventListener` bindings** (lines 1387, 1655, 1920,
  1982, 2586, 2721). Criterion 7 depends on them being untouched. The panel-close is a
  separate delegated listener.
- **Outside-click vs. toggle race:** the toggle handler must `stopPropagation()` (or check
  the target), otherwise the same click bubbles to the document listener and closes the
  panel the instant it opens.
- **CSS specificity / cascade order:** the new panel rules live *inside* the existing
  `@media (max-width: 600px)` block (style.css:1033). Ensure the `.nav-toggle { display:none }`
  default rule (step 2) sits *outside/above* any media query so desktop keeps it hidden, and
  the `display:inline-flex` override lives *inside* the ≤600px block. Because both target
  `.nav-toggle` at equal specificity, source order matters — the media-query rule must come
  later in the file (it does, at line ~1033 vs the topbar area at ~95).
- **Retire the 520px block fully** (step 3). Leaving its `.topbar h1 { flex: 1 1 100% }`
  would push the brand to its own row and break the "brand + ☰ share the first row" layout
  between 400-520px. Also confirm no *other* rule references the deleted `@media
  (max-width: 520px)` selectors (grep: only this block matched).
- **`display:none` won't animate** — the panel uses `max-height`/`visibility`. Don't
  "simplify" it back to `display:none`, or the slide transition and the closed-state
  tab-order exclusion both break differently.
- **Sticky-header growth:** because the panel is inside the sticky `.topbar`, an open panel
  makes the sticky header taller. That's the intended "push content down" behavior; just
  confirm the page content below reflows and nothing is hidden under the header when open.
- **60vh cap on very short screens:** `overflow-y: auto` on the open panel is the safety net
  if six 44px buttons ever exceed the cap (they won't at normal sizes) — keep it.

## Out of scope
- The search-card secondary button row (☰ Batch / Paste) — explicitly not part of this
  change.
- Any modal *content* or behavior (Library, Watchlist, History, Status, Recipients,
  Settings modals themselves are untouched).
- Changing any button's handler or behavior — only their container/visibility changes.
- Desktop layout above 600px — must remain pixel-identical to current behavior.
- No new dependencies, no build tooling, no server/API changes, no new files.
