# UI/UX Review: Library panel & Watchlist modal

**Complaint:** both feel "very tight and crammed."
**Scope:** review + redesign proposal only — no code changed.

Files reviewed:
- `public/index.html` — Library drawer lines 122–140, Watchlist modal lines 170–189
- `public/app.js` — `renderLibrary()` / `renderLibraryBook()` / `renderLibraryGridCard()` / `renderLibraryCover()` (~2126–2317), `renderSend()` (2398–2410), `renderWatchlist()` / `watchStatusBadge()` / `buildWatchCover()` (~2627–2774)
- `public/style.css` — tokens 1–60, `.card` 267–283, watchlist 426–464, library drawer 481–686, library management 1123–1154

---

## 1. Diagnosis

### 1.1 Library list row (`.lib-book`) — too many strata, all equally weighted

`renderLibraryBook()` (app.js:2231–2317) stacks **seven visual strata** into one
0.9rem-padded box (`.lib-book`, style.css:594–599):

1. Title (`.lib-title`, 1rem)
2. Author (`.lib-author`, 0.86rem)
3. Filename (`.lib-filename hint`) — shown whenever `filename !== title`, i.e. almost always
4. Badges row (`.badges`: External/Premium + Verified)
5. Meta row (`.meta`: 📦 size, 📅 date)
6. Tags row (`.lib-tags` + always-present `✎ Tags`/`＋ Tag` button)
7. Below the cover block: full send history (`.lib-sends`, one line **per send**, unbounded) and an actions zone (`.lib-actions`) with a **full-width orange** `📧 Resend` button plus a `🗑 Delete` ghost button.

Specific cramping causes, with selectors:

- **No hierarchy in the vertical rhythm.** The inter-stratum margins are all
  within one tiny band: `.lib-title` `margin: 0 0 0.15rem` (style.css:646),
  `.lib-author` `0 0 0.3rem` (645), `.lib-filename` `margin-bottom: 0.5rem`
  (647), `.lib-book .badges` `0.5rem` (648), `.lib-book .meta` `0.6rem` (649),
  `.lib-tags` `margin-top: 0.5rem` (1135). When everything is 0.15–0.6rem
  apart, nothing groups and nothing separates — the eye reads it as one dense
  block. Row-to-row gap is only `0.85rem` (`.library-list`, 511), barely more
  than the intra-row spacing, so rows also blur together.
- **Redundant/noisy content.** The filename usually restates the title
  (`Title - Author.epub`) and with `word-break: break-word` (647) a long
  filename wraps to 2–3 lines of dim noise directly under the real title.
  The 📦/📅 emoji in `.meta` (app.js:2238–2239) add glyph clutter for data
  that labels itself (a byte size, a date).
- **Repeated heavy CTA.** `.lib-resend { width: 100% }` (664) puts a
  full-width orange primary button in *every* row. With 20 books, that is 20
  identical loud buttons — the accent stops signalling anything and the rows
  feel button-dominated.
- **`.lib-actions` has no layout rules** — only `margin-top: 0.8rem` (663).
  The full-width resend button forces `🗑 Delete` onto its own line below with
  no defined gap; the delete button just floats there, left-aligned under a
  full-width button. Same in the missing-file branch (`⚠ File removed` + `⬇
  Re-download` + `🗑 Delete` all rely on inline flow).
- **Send history is unbounded and always expanded** (app.js:2243–2249). A book
  sent 5× gets 6 extra lines ("Sent 5×" header + 5 `.lib-send` rows) in every
  render. Even never-sent books pay a stratum ("Not sent yet") plus the dashed
  divider (`.lib-sends`, 652–657).
- **The always-visible checkbox** (`.lib-select`, 1133, rendered at
  app.js:2293) sits at the far left of every row. The grid view already solved
  this better — `.lib-tile-select` is hover/selected-revealed (559–564) — but
  the list view didn't get the same treatment.
- **Cover is under-leveraged.** 64×96 (`.lib-cover`, 603–611) is smaller than
  the search card's 96×140 (`.card .cover`, 288–295) while the row carries
  *more* text — inverted proportions vs. the established card language.
- **No list-view breakpoint.** The drawer is `min(560px, 94vw)` (485); on
  narrow screens the `lib-top` flex (601) squeezes `.lib-main` next to the
  64px cover + 18px checkbox and everything wraps harder.

### 1.2 Watchlist row (`.watch-row`) — a rigid grid stuffed with wrapping text and three buttons

`renderWatchlist()` (app.js:2641–2748) packs each `.watch-row` with: cover,
quoted title/author, status badge (+ optional 📈 List provenance badge), an
"Open the match ↗" link, checked-date/error text, delivery counts, recipient
names + inline "Recipients" editor toggle + expandable checkbox editor, and
2–3 always-visible ghost buttons.

- **Fixed non-responsive grid.** `.watch-row { grid-template-columns: 52px
  1fr }` (style.css:432) never re-stacks. The only mobile rule in the whole
  watchlist block is for the *add form* (`@media (max-width: 520px)` at
  459–464 — note the duplicated media query, the second one targets
  `.watch-form` with a `grid-template-columns` it doesn't have, i.e. dead
  CSS). Inside a `min(560px, 94vw)` card with `1.5rem` `.modal-card` padding
  (699–709), on a 375px phone the content column is ~250px wide; the meta
  line, recipient line and three buttons all wrap into a tall ragged stack.
- **Badge-cluster bug.** `watchStatusBadge()` (app.js:2636–2638) wraps the
  status badge + `📈 List` badge in a bare `el('span', {}, [badge, badge])`
  with no class — the two pills render **touching, zero gap**. That is
  literally "crammed."
- **Head fights itself.** `.watch-head` is `justify-content: space-between`
  with no `flex-wrap` (437); a long quoted title compresses against the badge
  cluster instead of letting badges drop to a second line.
- **One meta line, four jobs.** `.watch-meta` (439) mixes the fulfilled-match
  link, the checked-date/count, the error text (`⚠ …` inline, same styling as
  the happy path apart from the glyph), and delivery counts — all 0.84rem, all
  wrapping together with `margin: 0.45rem 0`.
- **Three buttons per row, always.** `Check now` / `Pause|Resume` / `Remove`
  (or `Watch again` / `Remove`) are all full text ghost buttons
  (`.watch-actions .ghost-btn`, 442) visible on every row. Like the Library's
  resend button, repetition turns actions into noise.
- **Row separation ≈ row padding.** `.watchlist-body { gap: 0.6rem }` (431)
  vs. `.watch-row { padding: 0.8rem 0.9rem }` (432) — the gaps between rows
  are smaller than the padding inside them, so the list reads as one slab.
- **The modal chrome eats the viewport.** Header + hint + notice + add form +
  recipient checkbox strip (`#watchAddRecipients`) all sit above a
  `max-height: 56vh` scroll body (431); on a laptop the actual list often gets
  ~40% of the screen.

### 1.3 What's already good (don't "fix")

- The grid view (`.lib-tile`, 530–592) is genuinely elegant: hover-revealed
  actions, sent-pip, cover-forward. It's the proof-of-concept for the fix —
  the list view and watch rows need the same *progressive disclosure*
  philosophy, not a new visual language.
- The token system (cream/navy/orange, `--radius`/`--radius-sm`/999px pills,
  `--font-rounded` headings, full dark variant at style.css:38–60) is coherent
  and should be reused verbatim.

---

## 2. Design proposal

**Principle:** keep the density *scale* (this app is compact everywhere — that
is its character) but restore **hierarchy** and **progressive disclosure**:
one primary line, one merged secondary line, everything else collapsed or
hover-revealed. Two strata per row at rest instead of seven.

### 2.1 Library list row — "ledger row with a drawer"

**Resting state (per `.lib-book`):**

```
[cover 72×108]  Title (1rem, --font-rounded, 650)          [📧] [🗑]
                Author (0.86rem, --text-dim)
                Premium · Verified ✓ · 2.1 MB · Jul 3 · fantasy ×2
                → Sent to Anna, Dad · last Jul 3            [⌄]
```

- **Container:** keep `.lib-book` but bump `padding: 1rem 1.1rem` and
  `border-radius: var(--radius)` (14px, matching `.card` instead of the odd
  one-off 12px). List gap `1rem` (from 0.85rem) so gap > internal spacing and
  rows finally separate. Add `box-shadow: var(--shadow-sm)` and the same
  hover lift as `.card` (267–283) — currently `.lib-book` is flat-bordered
  while search cards are shadowed; unifying them makes the whole app one
  card language.
- **Layout:** replace the `lib-top` flex + stacked zones with a grid:
  `grid-template-columns: 72px 1fr auto; column-gap: 0.9rem` — cover, main,
  action cluster. Cover grows 64×96 → **72×108** (still 2:3, radius 7px→8px);
  it earns the space back from removed text strata.
- **Primary stratum:** `.lib-title` in `--font-rounded` weight 650 (list rows
  currently inherit it via the `h3` rule, keep that), `margin-bottom:
  0.2rem`; `.lib-author` unchanged, `margin-bottom: 0.5rem`.
- **Merged secondary stratum:** collapse badges + meta + tags into **one**
  `.lib-metaline` — `display: flex; flex-wrap: wrap; gap: 0.35rem 0.6rem;
  font-size: 0.78rem; color: var(--text-dim)`. Mode/Verified stay pills
  (`.badge`, existing 0.72rem style); size/date become plain text **without
  the 📦/📅 emoji**; tags stay `.lib-tag` pills. The `✎ Tags` button moves
  into the expanded drawer (below) — it's an editing affordance, not
  scan-time info.
- **Filename: hidden at rest.** Move it into the expanded drawer (and/or
  `title=` tooltip on the title). This alone deletes 1–3 wrapped lines per
  row.
- **Send summary, one line:** replace the always-expanded `.lib-sends` block
  with a single `.lib-send-summary` line, `font-size: 0.8rem`:
  `→ Sent to Anna, Dad · last Jul 3` (data already computed this way in the
  send-modal's `renderSends()`, app.js:656–657) or italic dim `Not sent yet`.
  Suffix a `⌄` disclosure that expands the full per-send history
  (`renderSend()` rows, unchanged markup) inside the drawer. Keep the dashed
  `border-top` divider — but only above this summary line, `margin-top:
  0.65rem; padding-top: 0.55rem`.
- **Actions: compact cluster, top-right.** Kill `.lib-resend { width: 100% }`.
  New `.lib-row-actions` in the third grid column: a **compact** send button —
  keep it `primary-btn`-colored but sized `padding: 0.4rem 0.7rem; font-size:
  0.8rem` (mirroring `.lib-tile-send`'s restraint) — plus an **icon-only**
  `🗑` ghost (30×30px, `border-radius: var(--radius-sm)`,
  `hover: border-color/color: var(--danger)` — reuse the existing
  `.lib-del-btn:hover` rule at 1154). On rows with a missing file, the cluster
  shows `⬇` re-download + `🗑`, and `⚠ File removed from disk` moves onto the
  metaline as a `--warn`-colored chip.
- **Checkbox: hover-revealed,** exactly like the grid tiles: `.lib-select
  { opacity: 0; transition: opacity var(--ease) }` with
  `.lib-book:hover .lib-select, .lib-select:checked { opacity: 1 }`,
  absolutely positioned top-left of the cover (or overlaid on its corner like
  `.lib-tile-select`, 559–564). Selected rows get the same
  `outline: 2px solid var(--accent)` treatment as `.lib-tile.selected` (565).
  Touch devices: add `@media (hover: none) { .lib-select { opacity: 1 } }`.
- **Drawer breakpoint:** `@media (max-width: 440px)` inside the panel — the
  action cluster drops to a footer row (`grid-column: 1 / -1;
  justify-content: flex-end; margin-top: 0.6rem`) and the cover shrinks to
  56×84.

Net effect: a never-sent book goes from ~9 rendered lines + full-width button
to **3 lines + a small button cluster** — roughly 40–50% shorter rows, with
zero information lost (it moved behind one tap).

### 2.2 Watchlist row — responsive grid + one line per concern

**Resting state (per `.watch-row`):**

```
[cover 56×84]  "Project Hail Mary" by Andy Weir    [Active] [📈 List]
               checked Jul 11 · 14×                          — status line
               → Anna, Dad · Recipients                      — delivery line
               [Check now]  [⏸] [🗑]
```

- **Container:** `padding: 0.9rem 1rem`; `.watchlist-body { gap: 0.75rem }`
  so separation beats internal padding. `border-radius: var(--radius)`
  (14px) to match everything else. Cover bumps 52×76 → **56×84** (2:3),
  `border-radius: var(--radius-sm)` on the image.
- **Make the grid responsive** (the headline structural fix):

  ```css
  .watch-row { grid-template-columns: 56px 1fr; gap: 0.9rem; }
  @media (max-width: 480px) {
    .watch-row { grid-template-columns: 44px 1fr; gap: 0.7rem; }
    .watch-actions { grid-column: 1 / -1; }   /* actions get full width */
  }
  ```

  (Requires `.watch-actions` to be a direct grid child — move it out of
  `.watch-row-main` in `renderWatchlist()`, app.js:2745–2746, into the row.)
  Also delete the dead duplicate `@media (max-width: 520px) { .watch-form
  { grid-template-columns: 1fr } }` block at style.css:462–464.
- **Fix the badge cluster:** give the wrapper from `watchStatusBadge()`
  (app.js:2638) a class — `.watch-badges { display: inline-flex; gap:
  0.35rem; flex: none }` — killing the touching-pills bug. Change
  `.watch-head` to `flex-wrap: wrap; justify-content: space-between; gap:
  0.3rem 0.6rem` so long titles push badges to line 2 instead of crushing
  them.
- **Split `.watch-meta` into two purposeful lines:**
  - **Status line** (`0.8rem`, `--text-dim`): `checked Jul 11 · 14×`, or on
    error a proper chip — `⚠ message` in a `color: var(--warn)` /
    `background: color-mix(in srgb, var(--warn) 10%, transparent)` pill
    (mirrors the existing `.badge.prem` recipe at 324–328) so failures are
    visible at a glance instead of blending into hint text.
  - **Delivery line** (fulfilled rows): `Open the match ↗` link (accent,
    600 weight) + `sent to 2, 1 to Kindle`. Non-fulfilled rows simply don't
    render this line — today's code already branches; the change is not
    mixing both concerns into one wrapping flexbox.
  - Spacing: `margin: 0.4rem 0 0` on each; drop the symmetric `0.45rem 0`.
- **Recipient line stays one line** (`→ Anna, Dad · Recipients`), 0.8rem; the
  inline editor keeps its `--surface-2` inset but gets `padding: 0.6rem
  0.7rem; border-radius: var(--radius-sm); margin: 0.45rem 0` and a
  `border: 1px solid var(--border)` so the expanded state reads as a
  deliberate inset panel, not spilled checkboxes.
- **Actions: 1 text button + icon ghosts.** Keep the *contextual* action as
  text (`Check now`, or `Watch again` when fulfilled); demote Pause/Resume and
  Remove to **icon-only** 30×30 ghost buttons (`⏸`/`▶`, `🗑`) with `title`
  tooltips and `aria-label`s, `gap: 0.45rem`, `margin-top: 0.6rem`. Remove
  keeps the existing `.watch-del:hover` danger treatment (443). This cuts the
  per-row button text from ~3 words × N rows to one.
- **Modal chrome:** widen `.watchlist-card` to `min(640px, 94vw)` (there is
  room — the batch card is already 560px and this modal carries more
  structure); bump `.watchlist-body` to `max-height: 62vh`. When
  `watchRecipientsList.length > 3`, collapse the add-form recipient strip
  behind a `Send to: 2 selected ⌄` disclosure so the form stays two lines
  tall.

### 2.3 Shared spacing recipe (both components)

| Token | Value | Used for |
|---|---|---|
| stratum gap (within a group) | 0.2–0.35rem | title→author, badge gaps |
| group gap (between concerns) | 0.55–0.7rem | metaline→send-summary, meta→actions |
| row padding | 0.9–1.1rem | `.lib-book`, `.watch-row` |
| row gap (list) | 0.75–1rem | `.library-list`, `.watchlist-body` |

This is still the repo's compact rem scale — the fix is that *between-group*
spacing is now reliably ~2× *within-group* spacing, which is what creates the
perception of air without actually adding much height.

---

## 3. What stays / what changes

**Stays (untouched):**
- Library grid view: `.lib-grid`, `.lib-tile*`, `renderLibraryGridCard()` — already the target quality bar.
- Cover machinery: `renderLibraryCover()`, `buildEditableCover()`, `buildWatchCover()`, lazy IntersectionObserver, lightbox.
- `.badge` / `.lib-tag` / `.lib-tag-chip` pill styles; `ghost-btn` / `primary-btn`; skeletons (`.lib-book.skeleton`); empty states (`.lib-empty`); tag bar; `.lib-actionbar`; drawer shell (`.library-panel`, header, search bar, view toggle); modal shell + animations; the watch add-form grid (its 520px stack rule already works).
- All API calls and handlers in `renderLibraryBook()` / `renderWatchlist()` — this is a re-layering of the same DOM nodes, not a data change.

**Changes — Library (`app.js` `renderLibraryBook()` + `style.css` 594–686, 1133):**
- Restructure row DOM: `lib-book` becomes 3-col grid (`cover | main | actions`); new `.lib-metaline` merges `.badges` + `.meta` + `.lib-tags`; new `.lib-send-summary` + disclosure replacing always-expanded `.lib-sends`; new `.lib-drawer` (expanded region) holding filename, full send history, `✎ Tags` editor trigger, and (missing-file case) re-download.
- Delete: `.lib-filename` at rest; `.lib-resend { width: 100% }`; 📦/📅 emoji.
- New CSS: `.lib-row-actions`, hover-reveal `.lib-select`, `@media (max-width: 440px)` stack rule, `.lib-book` shadow/hover parity with `.card`.

**Changes — Watchlist (`app.js` `renderWatchlist()`/`watchStatusBadge()` + `style.css` 426–464):**
- Bug fixes: classed `.watch-badges` wrapper with gap (app.js:2638); remove dead `@media` block (style.css:462–464).
- `.watch-actions` promoted to direct grid child; responsive `@media (max-width: 480px)` rules; `.watch-meta` split into `.watch-status-line` / `.watch-delivery-line`; error chip style; icon-only Pause/Remove; card width 560→640px; recipient-strip disclosure in the add form.

---

## 4. Consistency notes

- **Zero new tokens.** Everything above uses existing `--surface/-2`,
  `--border(-strong)`, `--text(-dim)`, `--accent`, `--good/--warn/--danger`,
  `--radius/--radius-sm`/999px pills, `--shadow-sm/--shadow`, `--ease`,
  `--font-rounded`. The error chip and warn chip reuse the established
  `color-mix(in srgb, <color> N%, transparent)` recipe already used by
  `.badge.prem/.own/.set` — so both light and dark mode are automatically
  correct with **no new dark-mode overrides needed** (the only hardcoded
  colors in the touched blocks today are the `rgba(0,0,0,…)` cover shadows,
  which already read fine on both themes and stay as-is).
- **Radius unification is a consistency *win*:** `.lib-book` (12px) and
  `.watch-row` (12px) are currently the only cards off the 14px `--radius`
  scale; the proposal moves them onto it.
- **The row layout converges on the `.card` pattern** (`cover-col | content`,
  1rem padding, `--shadow-sm`, hover lift) — search results, library rows and
  watch rows become recognizably one family at three densities.
- **Progressive disclosure mirrors existing behavior:** hover-revealed
  controls copy `.lib-tile-select`/`.lib-tile-send`; the send-history
  disclosure copies the `.watch-recip-editor` show/hide pattern already in
  the codebase. No new interaction idioms.
- Spacing stays in the repo's 0.2–1.1rem band; nothing jumps to an "airy"
  1.5–2rem system that would make these two surfaces feel like a different
  app.

---

## 5. Open questions for Eric

1. **Keep a "compact" list mode?** The proposal makes list rows ~40–50%
   shorter, but if you *like* seeing full send history and filenames at a
   glance, we could add a third density toggle (compact / comfy) next to the
   existing ☰/▦ toggle instead of changing the only list view. My
   recommendation: no third mode — the disclosure chevron covers it — but
   it's your scanning habit.
2. **Filename: drawer or tooltip or gone?** It mostly duplicates the title.
   Options: (a) expanded drawer only (proposed), (b) `title=` tooltip on the
   row, (c) drop entirely from the UI. Any objection to (a)?
3. **Icon-only Pause/Remove on watch rows** — comfortable with `⏸`/`🗑` +
   tooltips, or do you want text labels kept on desktop and icons only under
   the 480px breakpoint?
4. **Send history default:** always collapsed, or auto-expanded when a book
   has exactly 1 send (cheap, and most books probably have 0–1)?
5. **Watchlist card width 560→640px** — fine, or do you prefer the modal
   footprint unchanged and rely purely on the internal re-layout?
6. **Tags at rest:** proposal keeps tag pills on the metaline (they're
   user-curated scanning data) but moves the `✎ Tags` edit button into the
   drawer. If you edit tags often, say so and the button stays at rest.
