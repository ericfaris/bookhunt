# Implementation plan: Library & Watchlist row redesign (progressive disclosure)

> Executor notes: this plan is self-contained but two companion docs exist in the
> same directory if you need rationale — `library-watchlist-redesign-brief.md`
> (the decisions) and `library-watchlist-uiux-review.md` (the diagnosis). This
> plan is authoritative where they differ.

## 0. Working-tree state — read this first

Run `git status` before doing anything. The working tree contains
**pre-existing, unrelated uncommitted changes** from a separate,
already-completed feature: `src/watcher.js`, `src/watchlist.js`,
`test/watcher.test.js`, `test/watchlist.test.js`, and a `package.json` version
bump. **Do not touch, revert, stage, commit, or attribute those files to this
task.** Your changes are limited to exactly three files:

- `/home/eric/projects/bookhunt/public/app.js`
- `/home/eric/projects/bookhunt/public/style.css`
- `/home/eric/projects/bookhunt/public/index.html` (one attribute change only — see Task 8)

If asked to commit, stage only these three files explicitly (`git add public/app.js public/style.css public/index.html`).

Line numbers below are as of commit `d336b7a` plus the unrelated src/test edits
(which don't touch these files). Verify each anchor with a quick search before
editing — treat the quoted code as the anchor, line numbers as hints.

---

## 1. Summary

The Library panel's list-view rows (`.lib-book`, built by `renderLibraryBook()`)
and the Watchlist modal's rows (`.watch-row`, built by `renderWatchlist()`)
currently stack up to seven equally-weighted visual strata per row — title,
author, filename, badges, meta, tags, full send history, plus a full-width
orange button — which reads as "tight and crammed." This change restructures
both rows around progressive disclosure: 2–3 strata at rest (title/author, one
merged metaline, one summary line), with everything else behind a disclosure
drawer or hover reveal. Along the way it fixes a real bug (the watch-row status
badge and "📈 List" badge render touching, zero gap), makes the watch row's
grid actually responsive below 480px, deletes a dead CSS block, and converges
both rows onto the app's existing `.card` design language (14px `--radius`,
`--shadow-sm`, hover lift). Pure frontend; zero new CSS custom properties; no
backend, API, or data-shape changes.

## 2. Approach & key decisions

**Design principle:** keep the app's compact rem scale (that's its character)
but restore hierarchy — between-group spacing ≈ 2× within-group spacing, and
row-to-row gap > row-internal padding. Copy existing idioms only: the
hover-reveal checkbox copies `.lib-tile-select` (style.css:559–564), the
disclosure drawer copies the `.watch-recip-editor` `hidden`-toggle pattern
(app.js:2680–2697). The `.card` block (style.css:267–283) is the visual target:
`border-radius: var(--radius)` (14px), `box-shadow: var(--shadow-sm)`, hover
`box-shadow: var(--shadow); border-color: var(--border-strong); transform: translateY(-2px)`,
with a `prefers-reduced-motion` guard.

**Decisions already made (do not reopen):**
- No third density toggle — the single list view is redesigned in place; grid view untouched.
- Filename moves into the expand drawer (not a tooltip, not dropped).
- Send history **always starts collapsed** — no auto-expand for 1-send books.
- Watch-row Pause/Resume/Remove are icon-only (⏸/▶/🗑) **at all widths**, with `title` + `aria-label`. The contextual action (`Check now` / `Watch again`) stays a text button.
- Watchlist modal widens 560px → 640px; `.watchlist-body` max-height 56vh → 62vh.
- Tag pills stay on the metaline; the `✎ Tags` edit button moves into the drawer.
- `⬇ Re-download` (missing-file case) lives in the top-right action cluster as an icon button, **not** in the drawer.

**Rejected alternatives (for context):** tooltip-only filename (hurts touch
users), auto-expanding single-send history (inconsistent rest state), text
action buttons on desktop with icons only on mobile (two codepaths for no
gain), a new "compact/comfy" toggle (the drawer already covers the dense case).

**Testing reality:** `npm test` (`node --test test/*.test.js`) is backend-only
and will not exercise any of this. Verification is manual/visual in a browser —
Section 7 gives a concrete Playwright-based recipe including API mocking so you
don't need real library/watch data.

**Token discipline:** zero new CSS custom properties. Reuse `--surface(-2)`,
`--border(-strong)`, `--text(-dim)`, `--accent`, `--good/--warn/--danger`,
`--radius` (14px) / `--radius-sm` (9px) / 999px pills, `--shadow-sm/--shadow`,
`--ease`, `--font-rounded`, and the established chip recipe
`color-mix(in srgb, <color> N%, transparent)` (see `.badge.prem`,
style.css:324–328). Because only tokens are used, dark mode should follow
automatically — but verify visually, don't assume.

## 3. Current-state map (what you're changing)

**app.js**
- `renderLibraryBook(book)` — app.js:2231–2317. Builds `.lib-book` as: `.lib-top` flex (checkbox + editable cover + `.lib-main`), then `.lib-sends` (always-expanded history), then `.lib-actions` (full-width `.lib-resend` + `🗑 Delete`). `.lib-main` stacks title, author, `.lib-filename`, `.badges`, `.meta` (with 📦/📅 emoji, lines 2238–2239), `.lib-tags` (+ `✎ Tags` button).
- `renderSend(s)` — app.js:2398–2410. Per-send row markup. **Keep unchanged**; reuse inside the drawer.
- Send-summary recipe to copy: app.js:656–657 (in the library-hit card) already computes `[...new Set(book.sends.flatMap((s) => s.to || []))].filter(Boolean).join(', ')`.
- `watchStatusBadge(w)` — app.js:2627–2639. Bug at 2638: `el('span', {}, [badge, listBadge])` — bare span, no class, no gap.
- `renderWatchlist(watches)` — app.js:2641–2748. Builds `.watch-row` as `[buildWatchCover(w), main]` where `main` (`.watch-row-main`, line 2745) contains head, meta, recipLine, editor, **actions**.
- `loadWatchlist()` — app.js:2596–2625. Lines 2613–2619 render the add-form recipient strip into `#watchAddRecipients`.
- `recipientCheckboxes(selected)` — app.js:2578–2589. Reused by add form + per-row editor. Keep unchanged.
- **Do not touch:** `renderLibraryGridCard()` (2168–2210), `renderLibraryCover()` (2215–2229), `buildEditableCover()` (2322–2362), `buildCoverEditorBody()`, `buildWatchCover()` (2753–2774), `openSendModal`, `deleteLibraryBook`, `redownloadBook`, `editBookTags`, `updateLibActionBar`, any `fetch()` call or endpoint.

**style.css**
- Tokens: 8–60. `.card`: 267–304. `.badge` family: 312–351.
- Watchlist block: 426–464. Dead duplicate media query at **462–464** (`@media (max-width: 520px) { .watch-form { grid-template-columns: 1fr } }` — `.watch-form` is not a grid; the working rule for `.watch-form-row` is 459–461).
- `.library-list` gap: 511. Grid-view tile styles 525–592 (**untouched**, but note 539–545 override `.lib-cover-wrap/.lib-cover-mount/.lib-cover` to 100% inside `.lib-grid`, so resizing the list cover won't affect the grid).
- `.lib-book`: 594–599 (12px radius, no shadow). `.lib-top`: 601. `.lib-cover`: 603–611 (64×96, 7px radius). `.lib-cover-wrap`/`.lib-cover-mount`: 618–619 (64px wide).
- `.lib-author`/`.lib-title`/`.lib-filename`/`.lib-book .badges`/`.lib-book .meta`: 645–649. `.lib-sends` block: 652–661. `.lib-actions`/`.lib-resend`/`.lib-missing`: 663–665.
- Skeleton: 673–686 (`.lib-book.skeleton` sets `display: flex`, which will override the new grid — good, leave it).
- `.lib-select`: 1133. `.lib-tags`/`.lib-tag`/`.lib-tag-edit`: 1135–1144. `.lib-del-btn:hover`: 1154.
- `.modal-card`: 699–709 (1.5rem padding). `.watchlist-card`: 427.

**index.html**
- Library panel shell: 122–140; Watchlist modal shell: 170–189. Only line 184 (`#watchAddRecipients`) is relevant, and even that needs no HTML edit unless you choose to (Task 8 is JS-driven).

---

## 4. Step-by-step tasks

Do them in this order. Each task is independently verifiable in a browser
(reload after each; Section 7's mock harness makes that trivial).

### Task 1 — Watchlist quick fixes (CSS + one-line JS)

The smallest, highest-certainty wins. Files: `public/app.js`, `public/style.css`.

1. **Badge-gap bug.** In `watchStatusBadge()` (app.js:2638) change
   `return el('span', {}, [badge, el('span', …)])` to
   `return el('span', { className: 'watch-badges' }, [badge, el('span', …)])`.
2. Add CSS: `.watch-badges { display: inline-flex; gap: 0.35rem; flex: none; }`
   (place it in the watchlist block near `.watch-head`).
3. **Delete the dead block** at style.css:462–464 (the second
   `@media (max-width: 520px)` targeting `.watch-form`). Keep 459–461
   (`.watch-form-row` stack) exactly as is.
4. **`.watch-head`** (style.css:437): add `flex-wrap: wrap;` and change `gap: 0.6rem` to `gap: 0.3rem 0.6rem;`.

**Verify:** a list-sourced watch shows visible space between its status pill and
the `📈 List` pill; a long watch title wraps the badges to a second line instead
of crushing them.

### Task 2 — Watchlist container & row chrome

File: `public/style.css` (watchlist block, 426–446).

1. `.watchlist-card` (427): `width: min(560px, 94vw)` → `width: min(640px, 94vw)`.
2. `.watchlist-body` (431): `gap: 0.6rem` → `gap: 0.75rem`; `max-height: 56vh` → `max-height: 62vh`.
3. `.watch-row` (432): `border-radius: 12px` → `border-radius: var(--radius)`;
   `padding: 0.8rem 0.9rem` → `padding: 0.9rem 1rem`;
   `grid-template-columns: 52px 1fr` → `grid-template-columns: 56px 1fr`;
   `gap: 0.85rem` → `gap: 0.9rem`. Add `box-shadow: var(--shadow-sm);` and
   `transition: box-shadow var(--ease), border-color var(--ease);` plus a hover rule
   `.watch-row:hover { box-shadow: var(--shadow); border-color: var(--border-strong); }`
   (no translateY inside a scroll container — the lift transform is for the
   library row only; a shadow/border hover is enough here and avoids jitter
   while scrolling the modal body).
4. Cover bump 52×76 → 56×84: update the three width/height pairs in
   `.watch-cover`, `.watch-cover-img`, `.watch-cover-ph` (434–436), and change
   `border-radius: 6px` → `border-radius: var(--radius-sm)` on `-img` and `-ph`.

**Verify:** desktop modal is visibly wider; rows have 14px corners, a soft
shadow, and clear separation (gap between rows now < internal padding is fixed:
0.75rem gap vs 0.9rem padding is close, but the shadow does the separating).

### Task 3 — Watch row DOM: actions out of main, meta split in two

File: `public/app.js` (`renderWatchlist()`, 2641–2748) + `public/style.css`.

1. **Promote `.watch-actions` to a direct grid child.** At app.js:2745–2746 change:
   ```js
   const main = el('div', { className: 'watch-row-main' }, [head, meta, recipLine, editor, actions]);
   body.append(el('div', { className: 'watch-row' }, [buildWatchCover(w), main]));
   ```
   to:
   ```js
   const main = el('div', { className: 'watch-row-main' }, [head, ...metaLines, recipLine, editor]);
   body.append(el('div', { className: 'watch-row' }, [buildWatchCover(w), main, actions]));
   ```
   (`metaLines` comes from step 3 below.)
2. **CSS for the promoted actions.** With a 2-column grid and 3 children, the
   actions land in row 2. Add:
   ```css
   .watch-cover { grid-row: 1 / span 2; }   /* cover spans both rows */
   .watch-actions { grid-column: 2; display: flex; flex-wrap: wrap; gap: 0.45rem; margin-top: 0.15rem; align-items: center; }
   ```
   (Replace the existing `.watch-actions` rule at 441; keep the
   `.watch-actions .ghost-btn` sizing rule at 442.)
3. **Split `.watch-meta` into two purposeful lines.** Replace the `bits`/`meta`
   construction (app.js:2661–2670) with:
   - **Status line** — always rendered:
     `el('div', { className: 'watch-status-line' }, …)` containing either the
     checked text (`checked Jul 11 · 14×` / `not checked yet`, exactly the
     current strings from line 2665) as a plain span, **or**, when `w.lastError`
     is set, an error chip:
     `el('span', { className: 'watch-error-chip', title: w.lastError }, `⚠ ${w.lastError}`)`.
   - **Delivery line** — only when `w.status === 'fulfilled'`:
     `el('div', { className: 'watch-delivery-line' }, …)` containing the
     `Open the match ↗` link (when `w.foundUrl`) and, when
     `w.delivered || w.kindlePushed`, the `sent to N, M to Kindle` span (drop
     the leading `'· '` from the current string when it starts the line;
     keep `' · '` as a separator between link and counts).
   - Build `const metaLines = [statusLine, deliveryLine].filter(Boolean);` and
     spread it into `main` (step 1).
4. **CSS for the split lines + error chip** (new rules in the watchlist block, replacing `.watch-meta` at 439–440):
   ```css
   .watch-status-line { margin: 0.4rem 0 0; font-size: 0.8rem; color: var(--text-dim); }
   .watch-delivery-line { margin: 0.4rem 0 0; font-size: 0.8rem; color: var(--text-dim);
     display: flex; flex-wrap: wrap; gap: 0.25rem 0.6rem; align-items: baseline; }
   .watch-delivery-line a { color: var(--accent); font-weight: 600; }
   .watch-error-chip {
     display: inline-block; font-size: 0.74rem; font-weight: 600;
     padding: 0.15rem 0.55rem; border-radius: 999px;
     color: var(--warn);
     background: color-mix(in srgb, var(--warn) 10%, transparent);
     border: 1px solid color-mix(in srgb, var(--warn) 32%, transparent);
     overflow-wrap: anywhere;
   }
   ```
   You may delete the `.watch-meta` rules (439–440) once nothing renders that
   class — grep `watch-meta` in app.js to confirm it's gone.
5. **Recipient line spacing:** change `.watch-recip-line` (454) margin to
   `margin: 0.4rem 0 0;` and set `font-size: 0.8rem;` (it currently inherits
   `.hint` sizing via its class list — keep the `hint` class on the element).

**Verify:** a fulfilled watch shows two distinct dim lines (status, delivery);
an errored watch shows a warn-colored pill; actions sit on their own row under
the text, cover spanning beside them.

### Task 4 — Watch row: icon-only pause/remove + responsive breakpoint

File: `public/app.js` (2716–2743) + `public/style.css`.

1. **Pause/Resume** (app.js:2716): change the button to
   `el('button', { className: 'ghost-btn watch-icon-btn', type: 'button', title: w.status === 'paused' ? 'Resume' : 'Pause', 'aria-label': w.status === 'paused' ? 'Resume watch' : 'Pause watch' }, w.status === 'paused' ? '▶' : '⏸')`.
   Handler unchanged.
2. **Remove** (app.js:2738): change to
   `el('button', { className: 'ghost-btn watch-del watch-icon-btn', type: 'button', title: 'Remove', 'aria-label': 'Remove watch' }, '🗑')`.
   Handler unchanged. `Check now` / `Watch again` stay text buttons, unchanged.
3. **CSS:**
   ```css
   .watch-icon-btn { width: 30px; height: 30px; padding: 0; display: inline-flex;
     align-items: center; justify-content: center; font-size: 0.85rem;
     border-radius: var(--radius-sm); }
   ```
   (`.watch-del:hover` at 443 already gives the danger treatment — keep it.)
4. **Responsive breakpoint** — add after the existing 520px block:
   ```css
   @media (max-width: 480px) {
     .watch-row { grid-template-columns: 44px 1fr; gap: 0.7rem; }
     .watch-cover, .watch-cover-img, .watch-cover-ph { width: 44px; height: 66px; }
     .watch-cover { grid-row: auto; }
     .watch-actions { grid-column: 1 / -1; margin-top: 0.35rem; }
   }
   ```
5. **Recipient editor inset panel** — `.watch-recip-editor` (457): change to
   `padding: 0.6rem 0.7rem; border-radius: var(--radius-sm); margin: 0.45rem 0; border: 1px solid var(--border);`
   (keep `background: var(--surface-2)` and the flex properties).

**Verify:** ⏸/▶/🗑 render as square 30px ghosts with tooltips at every width;
narrowing devtools below 480px reflows the row (smaller cover, actions full
width) with no horizontal clipping; expanding "Recipients" shows a bordered
inset panel.

### Task 5 — Add-form recipient strip disclosure (>3 recipients)

File: `public/app.js` (`loadWatchlist()`, 2613–2619) + `public/style.css`.

1. In `loadWatchlist()`, replace the add-box population:
   - If `watchRecipientsList.length <= 3`: current behavior unchanged (label + checkboxes inline).
   - If `> 3`: append a toggle button and a hidden strip:
     ```js
     const strip = el('div', { className: 'watch-recipients-strip', hidden: true });
     strip.append(el('span', { className: 'watch-recip-label' }, 'Send to:'));
     for (const node of recipientCheckboxes(new Set())) strip.append(node);
     const toggle = el('button', { className: 'watch-recip-edit', type: 'button', 'aria-expanded': 'false' }, 'Send to: 0 selected ⌄');
     const updateLabel = () => {
       const n = strip.querySelectorAll('input:checked').length;
       toggle.textContent = `Send to: ${n} selected ${strip.hidden ? '⌄' : '⌃'}`;
     };
     strip.addEventListener('change', updateLabel);
     toggle.addEventListener('click', () => { strip.hidden = !strip.hidden; toggle.setAttribute('aria-expanded', String(!strip.hidden)); updateLabel(); });
     addBox.append(toggle, strip);
     ```
   - **Critical:** the submit handler (app.js:~2550s) reads checked boxes from
     `#watchAddRecipients` via `querySelectorAll` — confirm its selector still
     matches inputs nested inside `.watch-recipients-strip` (it queries within
     the container, so nesting is fine, but check the exact selector before
     assuming).
2. CSS: `.watch-recipients-strip { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem 0.8rem; flex-basis: 100%; }`
   (`[hidden] { display: none !important; }` at style.css:721 handles the collapsed state).

**Verify:** with ≤3 recipients the form looks exactly as before; with 4+ the
form is two lines tall with a "Send to: 0 selected ⌄" link that expands the
checkbox strip and live-counts selections; adding a watch still delivers the
checked recipient ids (watch the POST body in devtools Network tab).

### Task 6 — Library row DOM restructure (`renderLibraryBook()`)

File: `public/app.js` (2231–2317). This is the largest task. Rewrite the
function body's *assembly* while keeping every handler and endpoint call
byte-identical. Target DOM:

```
div.lib-book[.selected]
├─ div.lib-cover-cell            (grid col 1; position: relative)
│  ├─ buildEditableCover(book)    (unchanged call)
│  └─ input.lib-select.lib-row-select   (hover-revealed, absolute top-left)
├─ div.lib-main                   (grid col 2)
│  ├─ h3.lib-title
│  ├─ div.lib-author              (if book.author)
│  ├─ div.lib-metaline            (badges + size + date + warn chip + tag pills)
│  └─ div.lib-send-summary        (dashed top divider; summary text + ⌄ button)
├─ div.lib-row-actions            (grid col 3, top-right)
│  ├─ button.primary-btn.lib-send-btn   "📧 Send" / "📧 Resend"   (if filePresent)
│  ├─ button.ghost-btn.lib-icon-btn.lib-redownload  "⬇"           (if !filePresent && book.url && mode !== 'standard')
│  └─ button.ghost-btn.lib-icon-btn.lib-del-btn     "🗑"
└─ div.lib-drawer[hidden]         (grid col 1 / -1)
   ├─ div.lib-filename.hint       (if filename && filename !== title)
   ├─ div.lib-drawer-tags         (the ✎ Tags / ＋ Tag button, existing handler)
   └─ div.lib-sends               (existing head + renderSend(s) rows, unchanged)
```

Concrete steps:

1. **Metaline.** Replace `badges` (2232–2235) + `meta` (2237–2240) + `tagsRow`
   (2285–2290) with one `div.lib-metaline` containing, in order:
   - `el('span', { className: 'badge' }, book.mode === 'standard' ? 'External' : 'Premium')`
   - `book.verified ? el('span', { className: 'badge ok-badge' }, 'Verified ✓') : null`
   - `book.size ? el('span', { className: 'lib-meta-bit' }, formatBytes(book.size)) : null` — **no 📦 emoji**
   - `book.acquiredAt ? el('span', { className: 'lib-meta-bit' }, formatDate(book.acquiredAt)) : null` — **no 📅 emoji**
   - `!book.filePresent ? el('span', { className: 'lib-warn-chip' }, '⚠ File removed') : null`
   - one `el('span', { className: 'lib-tag' }, t)` per tag (as today, 2286)
   The `✎ Tags`/`＋ Tag` button (2287–2289, handler `editBookTags(book)` unchanged) moves into the drawer (step 4).
2. **Send summary + disclosure.** Replace the always-expanded `sendsWrap`
   placement with a one-line summary:
   ```js
   const sendCount = (book.sends && book.sends.length) || 0;
   let summaryText;
   if (!sendCount) summaryText = 'Not sent yet';
   else {
     const who = [...new Set(book.sends.flatMap((s) => s.to || []))].filter(Boolean).join(', ');
     const last = book.sends.reduce((m, s) => (s.timestamp > m ? s.timestamp : m), book.sends[0].timestamp);
     summaryText = `→ Sent to ${who || `${sendCount} reader(s)`} · last ${formatDate(last)}`;
   }
   ```
   Build `div.lib-send-summary` = `span.lib-send-summary-text` (add class
   `lib-notsent` styling via a modifier when `!sendCount` — reuse the existing
   italic-dim look) + `button.lib-disclose` (`type: 'button'`,
   `aria-expanded: 'false'`, `aria-label: 'Show details'`, text `⌄`).
   Click handler: toggle `drawer.hidden`, set `aria-expanded`, and toggle an
   `open` class on the button (CSS rotates the chevron).
3. **Drawer.** `const drawer = el('div', { className: 'lib-drawer', hidden: true }, [...])`
   containing: the filename div (2304–2306, unchanged condition/classes), a
   `div.lib-drawer-tags` wrapping the `✎ Tags` button, and the existing
   `sendsWrap` (`.lib-sends`, built exactly as today at 2243–2249 with
   `renderSend()` rows). Remove the standalone `sendsWrap` append at 2314.
4. **Actions cluster.** Replace `actions` (2252–2282):
   - `filePresent`: `el('button', { className: 'primary-btn lib-send-btn', type: 'button', title: … }, sendCount ? '📧 Resend' : '📧 Send')` — same `openSendModal({...})` payload as today (2257–2269), including `onSent: openLibrary`.
   - Missing file + premium + url: `el('button', { className: 'ghost-btn lib-icon-btn lib-redownload', type: 'button', title: 'Re-download', 'aria-label': 'Re-download' }, '⬇')` → `redownloadBook(book)` (2276).
   - Always: `el('button', { className: 'ghost-btn lib-icon-btn lib-del-btn', type: 'button', title: 'Remove from library', 'aria-label': 'Remove from library' }, '🗑')` → `deleteLibraryBook(book)` (2281).
   - The old `.lib-missing` text div (2272) is **not** rendered — the metaline warn chip replaces it.
5. **Checkbox.** Keep the existing element/handler (2293–2299) but add class
   `lib-row-select` and extend the change handler with
   `row.classList.toggle('selected', select.checked)` (mirror
   `renderLibraryGridCard`, 2174). Initialize the row with `' selected'` when
   `select.checked`, like the tile does (2202). Place it inside
   `div.lib-cover-cell` after `buildEditableCover(book)`.
6. **Assemble** the row as the four grid children shown above (no more
   `.lib-top` wrapper). Keep the function's return type (a `div.lib-book`) so
   `renderLibrary()`'s `--i` stagger (2160) still applies.

**Verify (with Task 7's CSS):** each row at rest = cover, title, author, one
metaline, one summary line; chevron opens/closes the drawer showing filename +
tags editor + full history; send/delete/re-download/tag-edit/multi-select all
still fire their original behaviors.

### Task 7 — Library row CSS

File: `public/style.css` (594–686, 511, 1133).

1. **`.lib-book`** (594–599) becomes:
   ```css
   .lib-book {
     display: grid;
     grid-template-columns: 72px 1fr auto;
     column-gap: 0.9rem;
     align-items: start;
     border: 1px solid var(--border);
     border-radius: var(--radius);
     padding: 1rem 1.1rem;
     background: var(--surface);
     box-shadow: var(--shadow-sm);
     transition: box-shadow var(--ease), border-color var(--ease), transform var(--ease);
   }
   .lib-book:hover { box-shadow: var(--shadow); border-color: var(--border-strong); transform: translateY(-2px); }
   @media (prefers-reduced-motion: reduce) { .lib-book:hover { transform: none; } }
   .lib-book.selected { outline: 2px solid var(--accent); outline-offset: 1px; }
   ```
2. **Delete** `.lib-top` (601) — no longer rendered. Keep `.lib-main` (602)
   as `min-width: 0;` (drop `flex: 1`, meaningless in grid).
3. **Cover 64×96 → 72×108** (radius 7px → 8px): `.lib-cover` (603–611)
   width/height, `.lib-cover-wrap` width (618), `.lib-cover-mount` (619)
   width/height. The `.lib-grid` overrides at 539–545 keep the grid view at
   100%, so this only affects list rows. Add:
   ```css
   .lib-cover-cell { position: relative; width: 72px; }
   ```
4. **Hover-revealed checkbox** — after `.lib-select` (1133) add:
   ```css
   .lib-row-select {
     position: absolute; top: 4px; left: 4px; z-index: 2; margin: 0;
     opacity: 0; transition: opacity var(--ease);
   }
   .lib-book:hover .lib-row-select,
   .lib-row-select:checked,
   .lib-row-select:focus-visible { opacity: 1; }
   @media (hover: none) { .lib-row-select { opacity: 1; } }
   ```
   (The base `.lib-select` rule keeps sizing 18px; its `margin-top: 3px` is
   overridden by `margin: 0` here. `.lib-tile-select` already layers its own
   absolute positioning for grid — untouched.)
5. **Text strata:** `.lib-title` (646) margin → `0 0 0.2rem`; `.lib-author`
   (645) margin → `0 0 0.5rem`. `.lib-filename` (647): keep the rule (now only
   appears inside the drawer). **Delete** `.lib-book .badges` (648) and
   `.lib-book .meta` (649) — those wrappers are no longer rendered in list rows
   (the generic `.badges`/`.meta` rules at 309–312 still serve the search cards).
6. **Metaline** (new):
   ```css
   .lib-metaline { display: flex; flex-wrap: wrap; align-items: center;
     gap: 0.35rem 0.6rem; font-size: 0.78rem; color: var(--text-dim); }
   .lib-warn-chip {
     display: inline-block; font-size: 0.72rem; font-weight: 600;
     padding: 0.12rem 0.5rem; border-radius: 999px;
     color: var(--warn);
     background: color-mix(in srgb, var(--warn) 10%, transparent);
     border: 1px solid color-mix(in srgb, var(--warn) 32%, transparent);
   }
   ```
   Delete `.lib-missing` (665) once nothing renders it (grep first — it is
   list-row-only today).
7. **Send summary + disclosure** (new):
   ```css
   .lib-send-summary {
     display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;
     border-top: 1px dashed var(--border);
     margin-top: 0.65rem; padding-top: 0.55rem;
     font-size: 0.8rem; color: var(--text-dim);
   }
   .lib-send-summary .lib-notsent { font-size: inherit; }
   .lib-disclose {
     flex: none; width: 26px; height: 26px; padding: 0;
     border: 1px solid var(--border); border-radius: var(--radius-sm);
     background: none; color: var(--text-dim); cursor: pointer;
     display: inline-flex; align-items: center; justify-content: center;
     transition: transform var(--ease), color var(--ease), border-color var(--ease);
   }
   .lib-disclose:hover { color: var(--text); border-color: var(--border-strong); }
   .lib-disclose.open { transform: rotate(180deg); }
   ```
   `.lib-sends` (652–657): remove its `border-top`/`margin-top`/`padding-top`
   (the summary line owns the divider now); keep the flex column + gap. Keep
   `.lib-sends-head`, `.lib-send*`, `.lib-notsent` (658–661) as-is.
8. **Drawer** (new):
   ```css
   .lib-drawer { grid-column: 1 / -1; margin-top: 0.55rem;
     display: flex; flex-direction: column; gap: 0.5rem; }
   .lib-drawer .lib-filename { margin: 0; }
   ```
9. **Action cluster** (new) — and **delete** `.lib-actions` (663) and
   `.lib-resend` (664):
   ```css
   .lib-row-actions { display: flex; align-items: center; gap: 0.45rem; }
   .lib-send-btn { padding: 0.4rem 0.7rem; font-size: 0.8rem; white-space: nowrap; }
   .lib-icon-btn { width: 30px; height: 30px; padding: 0; display: inline-flex;
     align-items: center; justify-content: center; font-size: 0.85rem;
     border-radius: var(--radius-sm); }
   ```
   (`.lib-del-btn:hover` at 1154 already handles the danger hover; `.lib-redownload`'s
   old `margin-top` at 1145 should be removed since it now sits in the flex cluster.)
10. **List gap:** `.library-list` (511) `gap: 0.85rem` → `gap: 1rem`.
11. **Narrow breakpoint** (new, after the library block):
    ```css
    @media (max-width: 440px) {
      .lib-book { grid-template-columns: 56px 1fr; }
      .lib-cover-cell, .lib-cover-wrap { width: 56px; }
      .lib-cover, .lib-cover-mount { width: 56px; height: 84px; }
      .lib-row-actions { grid-column: 1 / -1; justify-content: flex-end; margin-top: 0.6rem; }
    }
    ```
    Note this media query keys on **viewport** width; the drawer is
    `min(560px, 94vw)` wide, so it only fires on genuinely narrow screens —
    that matches the brief ("New `@media (max-width: 440px)` rule").
12. **Skeleton sanity:** `.lib-book.skeleton` (673) sets `display: flex` which
    overrides the new grid — confirm the loading shimmer still looks right, no
    change expected.

### Task 8 — index.html

No structural change required — both shells (122–140, 170–189) already fit the
new JS-rendered DOM. The only permitted edit: none needed. If during
verification you find you want a hook (you shouldn't), stop and reconsider —
everything in this design is rendered from app.js.

---

## 5. Data / model / API changes

**None.** No file under `/home/eric/projects/bookhunt/src/` is touched — not
`src/library.js`, `src/watchlist.js`, `src/watcher.js`, `src/server.js`, nor
any route. Every `fetch()` call, method, URL, and request/response body in
`renderLibraryBook()` and `renderWatchlist()` stays byte-identical; this is a
re-layering of the same DOM data. No `test/` file is touched either.

## 6. Out of scope — do not build

- Library **grid view**: `.lib-grid`, `.lib-tile*`, `renderLibraryGridCard()` (app.js:2168–2210; style.css:525–592) — untouched.
- Cover machinery: `renderLibraryCover()`, `buildEditableCover()`, `buildCoverEditorBody()`, `buildWatchCover()`, `loadCover()`, the IntersectionObserver, the lightbox — untouched (only the boxes around them resize).
- No third density/compact toggle; no new view modes.
- `.watch-form-row`'s existing 520px stacking rule (style.css:459–461) — keep; only the dead duplicate (462–464) is deleted.
- No new CSS custom properties/tokens; no new dark-mode override blocks (verify tokens carry both themes).
- No new interaction idioms beyond the two copied patterns (hover-reveal, hidden-toggle disclosure).
- The library-hit search card (`.card.library-card`, app.js ~630–690) — its own layout, untouched.
- Docker rebuild / deploy — do not run `npm run docker:up` or any deploy step; code + verification only.
- No backend, API, storage, or test-suite changes of any kind.

## 7. Testing & verification

There is **no automated test coverage for any of this** — `test/*.test.js` is
backend-only. Do not treat a passing `npm test` as evidence. Verify visually,
and capture before/after screenshots as evidence.

### 7.1 Harness

The app serves static files from `public/` via `node src/server.js`
(`npm start`, or `npm run dev` for watch mode) on its configured port (check
`src/server.js` / `.env` for the PORT; default is likely 3000). The UI itself
loads without Mobilism credentials, but your local `data/` may have no library
books or watches — so **mock the API with Playwright route interception**
rather than depending on real data. The `webapp-testing` skill is available in
this environment: load it and use its Playwright tooling.

Before writing mocks, read the real response shapes: `openLibrary()` (search
app.js for `'/api/library'`) and `loadWatchlist()` (app.js:2596–2625, expects
`{ emailReady, notifyTo, recipients, watches }`; each watch uses `status`,
`source`, `listLabel`, `title`, `author`, `foundUrl`, `lastCheckedAt`,
`checkCount`, `lastError`, `delivered`, `kindlePushed`, `recipientIds`, `id`).
Library books use `id`, `title`, `author`, `filename`, `mode`, `verified`,
`size`, `acquiredAt`, `tags`, `sends[] ({to, timestamp, kindlePushed, channels})`,
`filePresent`, `url`, `cover`. Also stub `/api/cover*` to return `{ cover: null }`
so runs are deterministic and offline.

Craft mock data covering every branch:
- Library: (a) multi-send book with tags, (b) never-sent book without tags,
  (c) missing-file premium book with `url` (warn chip + ⬇ + 🗑), (d) missing-file
  standard book (🗑 only), (e) a book with a long filename.
- Watchlist: (a) active `source: 'list'` watch (badge-gap check), (b) paused
  watch, (c) fulfilled watch with `foundUrl` + `delivered`/`kindlePushed`,
  (d) active watch with `lastError` (error chip), (e) long-title watch
  (head-wrap check). Recipients: run once with 2 and once with 5 (strip
  disclosure threshold).

### 7.2 Before/after screenshots (required evidence)

**Before starting any edit**, with the mock harness working, capture:
`library-list-before.png`, `watchlist-before.png` (desktop ~900px viewport) and
`watchlist-mobile-before.png` (390px viewport). After all tasks, capture the
same three `-after` shots plus `library-drawer-open-after.png`,
`library-mobile-after.png` (390px), and dark-mode variants (Playwright:
`colorScheme: 'dark'` in the browser context) of the two main desktop shots.
Save them under the session scratchpad or `.claude/plans/` sibling dir and
reference their paths in your final report.

### 7.3 Manual/scripted click-through checklist

Library panel (open via the 📚/Library topbar button, list view ☰):
1. Row at rest shows exactly: cover 72×108, title, author, one metaline
   (Premium/External pill, Verified pill, size, date — **no 📦/📅**, tags), one
   send-summary line. **Filename not visible.**
2. Click ⌄ → drawer opens with filename, ✎ Tags button, full send history
   (per-send rows); click again → closes; `aria-expanded` toggles.
3. Action cluster top-right: compact 📧 button + 30px 🗑 icon; **no full-width
   button anywhere**. Missing-file rows: warn chip on the metaline, ⬇ + 🗑 in
   the cluster (⬇ absent on standard-mode books).
4. Hover a row → checkbox fades in top-left of cover; check it → row gets the
   accent outline and `#libActionBar` appears with the right count; uncheck →
   outline clears. Emulate touch (`hasTouch` / devtools) → checkbox always visible.
5. Tag pill filtering via `#libTagBar`, `#librarySearch` filtering, and the
   ☰/▦ toggle all still work; **grid view is pixel-identical to before**.
6. 📧 opens the send modal with correct title/author/cover; 🗑 prompts delete;
   ✎ Tags (in the drawer) opens the tag editor; ⬇ triggers re-download
   (verify the network calls fire — mocks can 200 them).
7. Rows have 14px radius + shadow, lift on hover; row gaps read larger than the
   old layout; a never-sent book is ~3 text lines tall.
8. 390px viewport: cover 56×84, action cluster drops to a right-aligned footer
   row, nothing clips horizontally.

Watchlist modal (🔔 button):
9. Modal is 640px wide on desktop; body scrolls at 62vh.
10. The list-source watch shows status pill and 📈 List pill **with a visible
    gap** (the bug fix — compare against `watchlist-before.png`).
11. Status line and delivery line are separate lines; errored watch shows a
    warn pill; non-fulfilled watches show no delivery line.
12. ⏸/▶/🗑 are icon-only with tooltips at desktop width too; `Check now` /
    `Watch again` remain text; pause→resume toggles (mock the POST), remove
    fires DELETE.
13. "Recipients" opens the bordered inset editor; Save posts the checked ids.
14. 390px viewport: cover shrinks to 44px, actions become a full-width row, no
    overflow.
15. With 5 recipients, the add form shows "Send to: 0 selected ⌄"; expanding
    and checking two updates it to "2 selected"; submitting posts those ids.
    With 2 recipients, the strip is inline as before.
16. Long watch title wraps badges to a second line (no crushing).
17. Repeat the two headline views in **dark mode** — chips, shadows, pills all
    legible; no hardcoded-light artifacts.
18. Empty states: mock empty library and empty watchlist → `.lib-empty` blocks
    render as before. Loading skeleton (throttle or delay the mock) still shimmers.

## 8. Risks & watch-outs

- **`.watch-actions` promotion is DOM + CSS, not CSS alone.** With actions
  still inside `.watch-row-main`, `grid-column: 1 / -1` does nothing (it's not
  a grid child). Task 3 step 1 (app.js:2745–2746) must land with its CSS
  (`.watch-cover { grid-row: 1 / span 2 }`) in the same pass or desktop rows
  will look broken mid-way.
- **Cover row-span vs. mobile:** remember to reset `grid-row: auto` on
  `.watch-cover` inside the 480px query (Task 4.4), or the spanning cover
  fights the full-width actions row.
- **`.lib-select` is shared.** The base rule (style.css:1133) styles both grid
  (`.lib-tile-select`) and list checkboxes. Add list behavior via the new
  `.lib-row-select` class only; do not edit 1133 itself beyond what Task 7.4
  specifies, or the grid view regresses.
- **`.badges`/`.meta` are shared with search cards.** Only delete the
  `.lib-book`-scoped margins (648–649), never the generic rules (309–312).
- **`.lib-grid` cover overrides** (539–545) are what protect the grid view from
  the 64→72px cover change — don't "clean them up."
- **Skeleton rows** reuse `.lib-book`; its `display: flex` override (673) must
  survive the grid conversion (it does if you keep the rule — just don't reorder
  it above the new `.lib-book` block).
- **Ordering:** do Task 1 first (isolated, instant payoff), then 2–5
  (watchlist), then 6–7 as one unit — Task 6's DOM without Task 7's CSS renders
  unstyled soup; commit them together if committing per-task.
- **`hidden` attribute pattern:** the codebase relies on
  `[hidden] { display: none !important; }` (style.css:721). Give the drawer and
  strip `hidden: true` via `el()` props (matches `.watch-recip-editor`,
  app.js:2680) rather than inline styles or classes.
- **`el()` helper:** props whose keys aren't element properties (e.g.
  `aria-label`, `title` on some elements) — check how `el()` (defined near the
  top of app.js) handles attribute-vs-property assignment; existing calls
  already pass `'aria-label'` (app.js:2170), so follow those precedents exactly.
- **Don't lose the `--i` stagger:** `renderLibrary()` (2160) sets it on the
  returned node — keep `renderLibraryBook()` returning the `.lib-book` element
  itself.
- **The watch add-form submit handler** reads checkboxes from
  `#watchAddRecipients` — after Task 5's nesting, re-verify the ids actually
  post (checklist item 15). This is the likeliest silent regression.
- **Working tree:** the unrelated `src/`+`test/`+`package.json` changes (§0)
  will show in `git status`/`git diff` the whole time. Never include them in
  anything you stage, and don't "fix" anything you notice in them.
