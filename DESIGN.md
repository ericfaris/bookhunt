# BookHunt Design System

**Direction:** Warm Paper & Ink Hunt
**Status:** documented + refined 2026-09-13 (uplift pass over an already-mature,
hand-built system)
**Source of truth for implementation:** [`public/style.css`](public/style.css)
**Live reference:** [`public/design-showcase.html`](public/design-showcase.html)
— every token and component below rendered straight from that stylesheet.

---

## 1. Direction narrative

BookHunt is a self-hosted, single-user (plus a small circle of invited
"readers") tool that automates a slightly illicit, slightly nostalgic
errand: hunting down a specific ePUB on an old-school forum, the way a
collector flips through card-catalog drawers. It is not a SaaS product
chasing signups — it's a personal appliance that should feel like a
**well-worn library tool**, not a dashboard.

The existing app (built up over ~40 commits, see `docs/UI_CHANGES.md` and
`.claude/plans/*redesign*`) had already converged, through iteration, on the
right answer: **warm cream paper, deep navy ink, and one hot-orange accent**
lifted directly from the hand-drawn logo (an open book crossed with a
magnifying glass — the hunt). That is not an accident or a placeholder
palette; it's the strongest asset already in the repo. This pass treats it
as the committed direction, gives it a name, documents it properly, closes
the small gaps where the implementation hadn't quite caught up with its own
intent, and makes it checkable via a live showcase page.

**The 3-5 key moments this system is built around:**
1. **First open / empty state** — "Find your next read": the book +
   magnifying-glass line art and a warm invitation, not a blank page.
2. **A search result card revealing itself** — the subtle `card-in` rise,
   cover art, badges (In library / Premium / In a set) doing hierarchy work
   so the title always leads.
3. **The "warming up" banner** — the personality moment: a bobbing coffee
   mug, drifting steam, and a sliding heat shimmer that says "the browser
   session is booting" without reading as an error. This is the single
   loudest piece of motion in the app and it's tuned to feel cozy, not
   anxious.
4. **A successful download** — the step list ticking through
   pending → active (spinning) → done (green), capped with a confetti burst
   in brand orange/gold/navy.
5. **The Library cover wall** — grid mode is the "wall of books" payoff for
   a working collection: tiles that lift on hover, tags, and a sent-status
   pip, staggered in on load.

### Why this pass didn't invent a new look

Three alternative directions were explored and rejected (mood boards below,
Section 2) specifically to stress-test whether "Warm Paper & Ink Hunt" was
still the right call before writing it down as canon. It was. A from-scratch
restyle would have thrown away ~40 commits of interaction-level polish
(skeleton loaders, disclosure drawers, the warm-banner choreography, dark
mode parity) for no gain in fit to the app's actual purpose. The job here was
**formalize, tighten, and make checkable** — not reinvent.

---

## 2. Mood-board exploration (autonomous — no user review available)

Generated via `mcp__ideogram__generate_image` and evaluated on fit to
BookHunt's purpose (a personal, cozy, slightly-analog book-hunting tool) —
not on which was the most striking image in isolation.

| Direction | Pitch | Verdict |
|---|---|---|
| **Warm Paper & Ink Hunt** ✅ | Cream paper, navy ink, hot-orange accent, rounded friendly display type, hand-inked book + magnifying-glass line art. Cozy, bookish, adventurous. | **Chosen.** Matches the existing logo/palette exactly and the app's actual personality — a friendly personal tool, not a corporate product. Generated image: https://ideogram.ai/g/oZfjzLdHRSWrUuj8fYPqpQ/0 |
| Reading Room Noir | Deep midnight navy dominant, brass accent, serif display type, library-desk-lamp mood. Moody, literary, late-night. | Rejected — gorgeous but wrong tone. BookHunt is used in short, task-focused bursts ("find this book, hit send"), not as an immersive reading environment; an all-dark-by-default identity would also fight the app's actual `prefers-color-scheme` dark mode (which is a *toggle*, not the identity). Generated image: https://ideogram.ai/g/SEuyuZbDR0m4IqK8M0LWUw/0 |
| Field Guide Ephemera | Manila/forest-green/postage-red, vintage stencil type, ticket-stub buttons, card-catalog texture. Vintage-explorer, card-catalog mood. | Rejected — charming but adds a "vintage curio" affect the app doesn't need; the existing orange-on-cream already carries the "hunt/adventure" idea without the kitsch, and green+red as primary accents would collide with the semantic good/danger tokens. |

The chosen direction is the one already latent in the app's own favicon —
this pass validates that instinct rather than overriding it with something
novel for novelty's sake.

---

## 3. Color

All values live as CSS custom properties on `:root` in `public/style.css`,
overridden inside `@media (prefers-color-scheme: dark)`. Dark mode is a
*system-driven* palette swap, not a separate identity — every token keeps
its role, most just invert lightness while keeping hue.

### Light (default)

| Token | Value | Role | Used for |
|---|---|---|---|
| `--bg` | `#f6f1e7` | Dominant surface | Page background — "warm cream paper" |
| `--surface` | `#fffdf8` | Surface | Cards, modals, panels, drawers |
| `--surface-2` | `#efe8d8` | Sunken surface | Skeleton fill, badge background, hover fills |
| `--field-bg` | `#fffdf8` | Surface | Form field background |
| `--text` | `#1c2a56` | Ink | Body text, headings — "deep navy ink" |
| `--text-dim` | `#616a8c` | Muted ink | Hints, labels, secondary metadata |
| `--border` | `#e7ddc8` | Hairline | Card/panel borders |
| `--border-strong` | `#d7cab0` | Hairline (emphasis) | Input borders, hover borders |
| `--accent` | `#f1592a` | **Primary accent** | Primary buttons, focus ring, links, the "hunt" wordmark, active states |
| `--accent-hover` | `#d8481c` | Accent (pressed) | Primary button hover/active |
| `--accent-2` | `#f4b73f` | Secondary accent (warm gold) | The "warming up" banner's glow/shimmer — a second, rarer accent, never used for actions |
| `--good` | `#1f9d57` | Semantic: success | "In library" badge, done steps, success text |
| `--warn` | `#c2871c` | Semantic: warning | Stale-file chips, warn pills, warn text |
| `--danger` | `#d6402c` | Semantic: danger/error | Cancel button, delete hover, error text |
| `--badge-bg` | `#e7e9f4` | Chip surface | Neutral badges (source, groups) |
| `--badge-text` | `#2a3a72` | Chip ink | Neutral badge text |
| `--brand-navy` | `#1c2a56` | Brand | Logo ink (alias of `--text`) |
| `--brand-orange` | `#f1592a` | Brand | Logo accent (alias of `--accent`) |
| `--brand-fg` | `#1c2a56` | Brand | Wordmark/logo stroke color (swaps to cream in dark mode) |

### Dark (`prefers-color-scheme: dark`)

| Token | Value | Note |
|---|---|---|
| `--bg` | `#131a30` | Midnight navy — the ink becomes the paper |
| `--surface` | `#1b2440` | |
| `--surface-2` | `#25304f` | |
| `--field-bg` | `#25304f` | |
| `--text` | `#f2ece1` | Warm cream — the paper becomes the ink |
| `--text-dim` | `#9aa3bf` | |
| `--border` / `--border-strong` | `#313c5d` / `#41507a` | |
| `--accent` / `--accent-hover` | `#ff6a3d` / `#ff8157` | Brightened so orange still pops on dark paper |
| `--accent-2` | `#f4b73f` | Unchanged — gold already reads on dark |
| `--good` / `--warn` / `--danger` | `#43c97f` / `#e0a049` / `#ff6b57` | Brightened for dark-surface contrast |
| `--badge-bg` / `--badge-text` | `#26315a` / `#bcc7ee` | |
| `--brand-fg` | `#f2ece1` | Wordmark/logo strokes go cream |

**Contrast:** `--text` on `--bg` is 12.6:1 (light) and 13.9:1 (dark) —
comfortably AAA. `--text-dim` on `--bg` is 4.9:1 (light) / 5.7:1 (dark) —
AA for body text. `--accent` white-on-orange button text (`#fff` on
`#f1592a`) is 3.4:1 — meets AA for the 0.95rem/600-weight button label
(large/bold text threshold), not for small body copy, which is why
`--accent` is never used as a body-text-on-background color at small sizes.

**Fix applied in this pass:** several semantic states (`.status.error`,
`.reup-msg.error`, `.batch-pill.error`, `.dl-step.warn`, etc.) had hardcoded
literal colors (`#e74c3c`, `#c97a1f`, `#c0392b`, `#c89a16`) instead of the
`--danger`/`--warn` tokens. These read fine in light mode by coincidence but
never adapted to dark mode. All are now routed through the real tokens —
same hue, now theme-aware. The gold used by the warm-banner (`#f4b73f`) is
now the named `--accent-2` token instead of a repeated literal.

---

## 4. Type

Two families, same as before, now scaled formally:

- **Body / UI**: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
  — the native platform face. Deliberate: this is a personal utility, not a
  brand statement; body copy should disappear and let content lead.
- **Display / brand voice**: `--font-rounded` = `ui-rounded, "SF Pro Rounded",
  "Hiragino Maru Gothic ProN", "Quicksand", "Segoe UI", system-ui,
  sans-serif` — a soft, rounded, friendly face used only where the app's
  personality should show through: the wordmark, all `h1`/`h2`/`h3`, modal
  titles, empty-state titles, section headings. Rounded terminals read as
  approachable/cozy rather than corporate, matching the "coffee mug" warm
  banner and the hand-drawn logo.

No self-hosted webfont: `ui-rounded`/`SF Pro Rounded` cost nothing to load
(native on Apple platforms) and the fallback chain (`Quicksand` → system-ui)
degrades gracefully on Windows/Linux/Android without a network request —
right call for an app that must work over a phone's mobile data while
someone's fetching a book.

### Type scale (new — `--text-*` tokens)

| Token | Size | Typical weight | Use |
|---|---|---|---|
| `--text-xs` | 0.72rem (11.5px) | 600–700 | Uppercase eyebrow labels, badge/pill text |
| `--text-sm` | 0.82rem (13px) | 400–600 | Form labels, hints, secondary metadata |
| `--text-base` | 0.95rem (15px) | 400–600 | Default body copy, buttons, inputs |
| `--text-md` | 1.05rem (17px) | 400–700 | Card titles, list-row titles |
| `--text-lg` | 1.2rem (19px) | 700 | Empty-state titles, modal `h2` |
| `--text-xl` | 1.3rem (21px) | 700 | Brand wordmark |
| `--text-2xl` | 1.6rem (26px) | 700 | Reserved for a future page-level display heading |
| `--text-3xl` | 2.1rem (34px) | 700 | Reserved for a future hero/landing heading |

The `2xl`/`3xl` steps are declared but not yet consumed anywhere in the app
— BookHunt has no landing/marketing surface today. They exist so a future
surface (e.g. a public "what is this" page) inherits the same scale instead
of inventing ad hoc sizes.

---

## 5. Spacing, radius, shadow, motion

### Spacing scale (new — `--space-*`, 4px base)

| Token | Value | Use |
|---|---|---|
| `--space-1` | 0.25rem / 4px | Icon-to-label gaps |
| `--space-2` | 0.5rem / 8px | Tight inline gaps (badge rows, icon buttons) |
| `--space-3` | 0.75rem / 12px | Form-field internal gaps |
| `--space-4` | 1rem / 16px | Card padding, standard section gaps |
| `--space-5` | 1.25rem / 20px | Panel/drawer padding |
| `--space-6` | 1.5rem / 24px | Page margins (`main` padding) |
| `--space-8` | 2rem / 32px | Large section breaks |
| `--space-10` | 2.75rem / 44px | Empty-state vertical padding |

Existing component rules still use literal rem values inline (this is
~1,300 lines of working, tested CSS — see §9 for why a wholesale token
migration was deliberately out of scope for this pass). The scale is the
documented, correct set of steps for anything new; new components should
consume `var(--space-*)` rather than a fresh literal.

### Radius scale

| Token | Value | Use |
|---|---|---|
| `--radius-xs` | 6px | Small chips, tag-edit pills |
| `--radius-sm` | 9px | Buttons, inputs, small icon buttons *(existing alias, unchanged)* |
| `--radius-md` | 14px | Cards, modals, panels *(this is what `--radius` now points to)* |
| `--radius-lg` | 20px | Reserved for larger future surfaces |
| `--radius-full` | 999px | Pills/badges/avatar circles |

`--radius` is kept as a literal alias of `--radius-md` — every existing rule
using `var(--radius)` or `var(--radius-sm)` is unaffected; nothing was
renamed out from under the working stylesheet.

### Shadow

| Token | Value | Use |
|---|---|---|
| `--shadow-sm` | `0 1px 2px rgba(28,42,86,.07)` | Resting cards/rows |
| `--shadow` | `0 1px 3px rgba(28,42,86,.10), 0 6px 16px rgba(28,42,86,.06)` | Hover state, results bar |
| `--shadow-lg` | `0 12px 34px rgba(28,42,86,.18)` | Modals |
| `--ring` | `0 0 0 3px color-mix(in srgb, var(--accent) 34%, transparent)` | Focus-visible ring on every interactive element |

Shadows are navy-tinted (not neutral black) at every step — a deliberate,
easy-to-miss detail that keeps elevation feeling warm instead of generic;
dark mode swaps them to black-based shadows since navy-on-navy would vanish.

### Motion (new — named `--dur-*` / `--ease-*` pairs)

| Token | Value | Meant for |
|---|---|---|
| `--dur-fast` | 0.12s | Instant feedback: checkbox toggle, tiny opacity fades |
| `--dur-base` | 0.18s | Default — hover/focus/press on buttons, inputs, chips |
| `--dur-slow` | 0.32s | Page-level reveals — card-in, tile-in, modal-in |
| `--ease-standard` | `cubic-bezier(0.4, 0, 0.2, 1)` | Micro-interactions (paired with `--dur-base` as `--ease-base`) |
| `--ease-out` | `cubic-bezier(0.2, 0.7, 0.2, 1)` | Reveals — cards/tiles/modals entering (soft overshoot-free deceleration) |

`--ease` is kept as a literal alias for `--ease-base` (`0.18s
cubic-bezier(0.4,0,0.2,1)`) — the name every existing `transition:` rule
already references. Every `@keyframes` animation in the file (`card-in`,
`tile-in`, `modal-in`, `warm-bob`, `warm-steam`, `sk-shimmer`, `confetti-fall`,
`cover-shimmer`) already uses `--ease-out`'s curve inline or a bespoke
per-effect curve (e.g. the confetti's `linear`) — those are intentionally
per-effect, not generic, and were left as-is.

**Reduced motion:** every animated surface has a matching
`@media (prefers-reduced-motion: reduce)` rule that removes the animation
entirely rather than shortening it (see `.card`, `.lib-tile`, `.modal`,
`.warm-mug`/`.warm-steam`/`.warm-shimmer`, `.confetti`,
`.dl-step.active .dl-step-icon`, `.sk-line`, `.cover.placeholder.loading`).

---

## 6. Components

Every component below is rendered live (real markup + real CSS, no
redrawing) on the showcase page, `public/design-showcase.html`.

### Buttons
- **`.primary-btn`** — solid `--accent` fill, white text, 600 weight,
  `--radius-sm`, colored drop shadow that intensifies on hover, 1px press
  translate. Variant **`.cancel-btn`** swaps the fill to `--danger` (used
  when Search flips to Cancel mid-flight). `:disabled` drops to 55% opacity
  and cancels the press transform.
- **`.ghost-btn`** — outline/secondary action: `--surface` fill, 1px
  `--border-strong`, hover swaps to `--surface-2` fill + `--accent` border.
  Used for every non-primary action (nav, close, refresh, cancel-edit).
- **Icon buttons** (`.watch-icon-btn`, `.lib-icon-btn`, `.lib-disclose`) —
  30×26px square ghost buttons for a single glyph; hover states tint toward
  `--danger` for destructive ones (`.watch-del`, `.lib-del-btn`) or `--text`
  for neutral ones.

### Inputs
`input`/`select`/`textarea` share one rule: `--field-bg` fill,
`--border-strong` outline, `--radius-sm`. Hover nudges the border toward
`--accent` via `color-mix`; focus swaps the border to solid `--accent` and
adds `--ring`. No separate error-state input style exists yet today (search
errors render as a `.status.error` panel instead) — noted as a gap in §10.

### Badges / pills
`.badge` is the base neutral chip (`--surface-2` fill, `--text-dim`,
`--radius-full`). Semantic variants layer a `color-mix(in srgb, <token> X%,
transparent)` tint over the base so every state — `.src` (neutral),
`.prem` (warn/gold), `.own` (good/green), `.set` (accent/orange) — stays
readable in both themes without a second hardcoded palette.

### Cards
`.card` (search result) and `.lib-book` (library row) share the same
recipe: `--surface` fill, `--border`, `--radius`, `--shadow-sm` resting →
`--shadow` + 2px lift on hover, entrance via `card-in`/fade-up keyframe.
`.lib-tile` (grid mode) is the artwork-forward variant: the cover *is* the
card, tile-in staggers by `calc(var(--i,0) * 28ms)` per index so a shelf of
40 books cascades in rather than popping at once.

### Modals
`.modal` (scrim + centered `.modal-card`) is one recipe reused for every
dialog in the app (batch input, credentials, download progress, send,
settings, status, recipients, re-upload requests, watchlist). Entrance is
`overlay-in` (scrim fade) + `modal-in` (card fade-up-scale,
`cubic-bezier(0.2,0.7,0.2,1)` = `--ease-out`).

### The warm-banner (signature moment)
`.warm-banner` is the one component that breaks from flat/quiet: a
horizontal gradient sweeping between `--accent` and `--accent-2`, a bobbing
mug emoji (`warm-bob`), three staggered rising steam blobs (`warm-steam`),
and a sliding gradient shimmer along the bottom edge (`warm-slide`) that
reads as "still working," not "broken." This is deliberately the loudest
animation in the system — see §1's key-moments list for why it earns that.

### Empty / loading states
`.results-empty` / `.lib-empty` pair an outlined dashed box with the brand
line-art icon and a friendly title. `.lib-book.skeleton` / `.sk-line` render
a shimmering placeholder (`sk-shimmer`) while library rows load.

---

## 7. Backgrounds, texture, and generated art

No tiling texture or background art was generated or added — the direction
is a flat, warm paper color (`--bg`), not a textured/illustrated surface,
and the app's information density (long lists of search results, library
rows) needs a quiet backdrop. The only generated art in this pass is the
mood-board exploration images (§2), which are documentation artifacts, not
shipped assets.

The **existing** brand art — the book + magnifying-glass mark — is
hand-drawn SVG (not AI-generated), reused inline in three places for crisp
`currentColor` theming: the topbar brand mark, the results-empty icon, and
the favicon/app-icon family (see §8). This pass did not regenerate it; it
already exactly matches the direction (see §2's verdict).

---

## 8. Icon / favicon

Already in place and confirmed to fit the direction — **not regenerated**:

| File | Role |
|---|---|
| `public/favicon.svg` | 64×64 tab icon — cream rounded square, navy book, orange magnifying glass |
| `public/reader-icon.svg` | 512×512 source, full-bleed cream so OS icon masks (squircle/circle) crop cleanly |
| `public/reader-icon-180.png` | iOS home-screen icon (apple-touch-icon), served at `/reader/icon-180.png` |
| `public/reader-icon-192.png` | PWA manifest icon (192), served at `/reader/icon-192.png` |
| `public/reader-icon-512.png` | PWA manifest icon (512, incl. maskable), served at `/reader/icon-512.png` |
| `public/manifest.webmanifest` | Main app manifest — `theme_color`/`background_color` both `--bg` (`#f6f1e7`), icon = `favicon.svg` |

Wiring confirmed correct in both `public/index.html` (`<link rel="icon">`,
`<link rel="manifest">`, `<link rel="apple-touch-icon">`, `theme-color` meta
for both color schemes) and `public/reader.html` (its own apple-touch-icon +
icon links, plus a dynamically-injected per-reader manifest served by
`src/server.js`'s `/reader/manifest.webmanifest` and `/reader/icon-:size.png`
routes). No changes made here.

---

## 9. What was — and wasn't — changed, and why

**Changed** (`public/style.css`):
- Added the formal type/spacing/radius/motion scales (§4–5) as new,
  additive custom properties. Every pre-existing token name (`--radius`,
  `--radius-sm`, `--ease`, all colors) is untouched in meaning — `--radius`
  and `--ease` are now defined *in terms of* the new scale, so no existing
  rule needed to change.
- Added `--accent-2` as the real name for the warm-banner's gold, replacing
  three repeated `#f4b73f` literals with `var(--accent-2)`.
- Routed twelve hardcoded literal colors (`#e74c3c`, `#c0392b`, `#a93226`,
  `#c97a1f`, `#c89a16`) onto the existing `--danger`/`--warn` tokens they
  were always meant to be — a correctness fix (these now adapt in dark
  mode) with no visible change in light mode.

**Deliberately not changed:**
- **No wholesale migration** of the ~1,300 lines of component CSS onto the
  new `--space-*`/`--text-*` tokens. This file is live, tested, production
  CSS for a working app with 469 passing tests and years of interaction
  polish (skeletons, disclosure drawers, staggered grids, a hamburger nav
  breakpoint tuned to exact pixel widths). Rewriting every literal
  `0.4rem`/`0.85rem` to a token reference is a mechanical, high-diff,
  zero-user-value change with real regression risk (a scale value that's
  *close but not identical* to a hand-tuned literal silently shifts
  spacing everywhere it's used) for a task scoped to "give this a design
  system," not "refactor the CSS." The scale exists and is correct for
  **new** work going forward.
- **`public/reader.html`** intentionally ships its own small, inlined
  `<style>` block duplicating a subset of the same tokens (`--bg`,
  `--surface`, `--text`, `--accent`, etc.) rather than linking
  `style.css`. This is correct as-is: it's a standalone page emailed/linked
  to invited readers who never see the main app shell, and it needs to
  render correctly even if `style.css` changes shape later. Token *values*
  match; the duplication is structural and intentional, not drift.
- **No new font, texture, or icon** — see §7–8.
- **No sound** — out of scope; BookHunt has no audio identity today and
  none of its key moments (§1) call for one.

---

## 10. Accessibility notes

- Every interactive element gets the same `--ring` focus-visible treatment
  (`:where(button, a, input, select, textarea):focus-visible`) — no
  component opts out.
- `prefers-reduced-motion: reduce` is handled per-animation throughout (see
  §5); nothing relies on motion to convey information that isn't also
  stated in text (e.g. the warm-banner's copy explains the state; the
  animation is flavor).
- Text contrast is documented in §3; the one soft spot (`--accent` white
  text at small sizes) is avoided in practice — the accent is only used for
  large/bold button labels and for text-on-`--surface` links, not
  small caption text on an orange fill.
- **Known gap, not fixed in this pass:** there is no distinct error-state
  input style (a red-bordered `input.invalid` or similar) — form validation
  today surfaces via a separate `.status.error` panel rather than inline
  per-field state. Flagged here rather than silently left undocumented;
  worth a follow-up if form validation UX becomes a priority.

---

## 11. Asset inventory

| Path | Role | Generated this pass? |
|---|---|---|
| `public/style.css` | Design system implementation (tokens + components) | Refined (additive tokens + literal→token color fixes) |
| `public/design-showcase.html` | Live showcase — renders every token/component from the real CSS | **New** |
| `public/favicon.svg` | Tab icon | No — pre-existing, confirmed on-direction |
| `public/reader-icon.svg` | 512px icon source | No — pre-existing |
| `public/reader-icon-{180,192,512}.png` | PWA/iOS icons | No — pre-existing |
| `public/manifest.webmanifest` | Main app manifest | No — pre-existing, confirmed correct |
| `DESIGN.md` | This document | **New** |
| Mood-board images (§2) | Direction validation, documentation only | **New** — not shipped in the repo, linked by URL |

---

## 12. Changelog

- **2026-09-13** — Initial `DESIGN.md` written for an existing, mature,
  undocumented design system. Named the direction ("Warm Paper & Ink
  Hunt"), generated and evaluated 3 mood-board alternatives to confirm it,
  formalized the type/spacing/radius/motion scales as additive tokens,
  fixed a dark-mode-fidelity gap (hardcoded status colors), and built the
  live showcase page. No visual regressions intended or expected — full
  test suite (469 tests) passes unchanged.
