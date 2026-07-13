# Implementation Plan: Book Blurbs in Library & Watchlist

Companion to the concept brief at `.claude/plans/book-blurbs-brief.md` (read it
too — it carries the acceptance criteria verbatim). Repo:
`/home/eric/projects/bookhunt`, branch `main`.

## ⚠ Pre-existing working-tree state — DO NOT TOUCH

The git tree is **not clean**. There are pre-existing uncommitted changes from a
prior, unrelated feature (an Amazon → Goodreads list-source swap):

```
 M .env.example
 M package.json            (version already bumped 1.17.2 → 1.18.0 by that work)
 M src/lists.js
 D src/listsources/amazon.js
 M src/listsources/goodreads.js
 M src/listwatcher.js
 M test/lists.test.js
?? .claude/plans/goodreads-genre-lists-brief.md
?? .claude/plans/goodreads-genre-lists-plan.md
?? .claude/plans/book-blurbs-brief.md
```

Rules for this task:

- Do **not** modify, revert, stage, commit, or attribute any of the files
  above. They are another feature's work-in-progress.
- Do **not** bump the version in `package.json` — it is already part of that
  untouchable diff.
- Do **not** commit or push anything at all unless the user explicitly asks.
- Your changes should be confined to `public/app.js` and `public/style.css`.
  If `npm test` shows failures, first check whether they exist on the
  *untouched* tree (they are then pre-existing, from the other feature) before
  assuming your change caused them.

## Summary

Add a short, collapsed-by-default synopsis ("blurb") to each row in the
Library row view and the Watchlist, lazily fetched via the existing
`GET /api/meta?title=&author=` endpoint only when a row scrolls into view.
The backend (Google Books lookup, description cleaning, disk caching in
`covers-cache.json` under `meta:` keys) already exists in
`src/covers.js:resolveMeta` and `src/server.js` (`/api/meta`, lines 759-769);
the collapsible renderer already exists as `buildSynopsis(text)` in
`public/app.js` (line 719). This task is pure frontend wiring: a blurb slot in
two row renderers, an `IntersectionObserver`-driven loader mirroring the
existing lazy-cover pattern, a client-side `Map` cache mirroring `coverCache`,
and a small CSS variant so the blurb stays visually modest inside rows.

## Approach & key decisions

**Design: mirror the lazy-cover pattern exactly.** The codebase already has a
proven convention in `public/app.js`:

- `coverCache` (line 1929): `Map` keyed `'title|author'` lowercased, value
  `url | null` (`null` = looked up, nothing found — a *negative* cache entry;
  `undefined` = never looked up).
- `coverObserver` (line 2079): a single module-level `IntersectionObserver`
  (`rootMargin: '200px'`) guarded by `('IntersectionObserver' in window)`;
  its callback unobserves and calls `loadCover(entry.target)`.
- `loadCover(holder)` (line 2090): reads `holder.dataset.title/.author`,
  checks the cache (`=== undefined` means fetch), fetches, caches (including
  `null` on failure), then paints **only if `holder.isConnected`** (the row
  may have been re-rendered away by a filter change).
- `renderLibraryCover` (line 2215): returns either the resolved element or a
  placeholder carrying `dataset.title`/`dataset.author`, registered with the
  observer — with an `else loadCover(holder)` eager-fetch fallback when
  IntersectionObserver is unsupported.

We add the blurb equivalents: `blurbCache` (Map), `blurbObserver`
(IntersectionObserver), `loadBlurb(slot)` (fetch `/api/meta`, cache
`description | null`, append `buildSynopsis(...)` if non-null and
`slot.isConnected`), and a small `makeBlurbSlot(title, author)` factory used
by both `renderLibraryBook` and `renderWatchlist`.

**Key decisions:**

1. **One observer with `root: null` (the viewport), shared by Library and
   Watchlist.** The existing `coverObserver` uses `root: libraryList` — but
   `#libraryList` is *not* the scroll container (the scrolling element is its
   ancestor `.library-panel`, `overflow-y: auto`, style.css line ~501). The
   Watchlist's scroll container is different again (`.watchlist-body`,
   `#watchlistBody`, `max-height: 62vh; overflow-y: auto`, style.css
   line 431). A viewport root works correctly for **both** surfaces: the
   library panel is `position: fixed; height: 100%`, so any row outside the
   panel's scrollport is also outside the viewport; the watchlist modal
   likewise sits within the viewport. A viewport root also handles the
   hidden-modal case naturally (elements inside a `hidden` modal don't
   intersect the viewport; the observer fires when the modal opens and the
   rows become visible).
   - *Rejected:* two per-surface observers with `root: libraryList` /
     `root: watchlistBody` — more code, and `libraryList` is the wrong root
     anyway (it doesn't clip; per the IO spec a non-scrolling root's
     intersection rect is its full bounding box, which makes lazy-loading
     against it ineffective). Don't "fix" `coverObserver` though — it is out
     of scope; just don't copy its root choice.
   - *Rejected:* extending `coverObserver`'s callback to also fetch blurbs —
     entangles two loaders, and covers/blurbs attach to *different* elements
     (cover placeholder vs. blurb slot), so one observer per concern on its
     own elements is cleaner. Keep `rootMargin: '200px'` for parity.
2. **A dedicated `blurbCache` Map, not reuse of `coverCache`.** Same key
   scheme (`'title|author'` lowercased) but different value semantics
   (description string vs. cover URL). Distinguish `undefined` (never
   fetched) from `null` (fetched, no description) exactly like `loadCover`
   does, so negative results are cached too and never re-fetched
   (acceptance criterion 5).
   - *Rejected:* seeding `coverCache` from the `/api/meta` response's `cover`
     field. Tempting micro-optimization, but it changes cover-loading timing
     and risks subtle interactions with `buildEditableCover`'s repaint logic.
     Skip it; the server's disk cache makes the second call cheap anyway.
3. **Reuse `buildSynopsis(text)` (app.js line 719) as-is** — required by the
   brief. Do not fork the clamp/toggle logic. It already renders
   `.synopsis > .synopsis-text.clamped` (3-line `-webkit-line-clamp`) with a
   `more`/`less` `.synopsis-toggle` button when text > 140 chars.
4. **Row-scoped CSS variant, not new classes on the synopsis internals.** Add
   a wrapper class on the slot element (`lib-blurb`) and scope tweaks as
   `.lib-blurb .synopsis-text { ... }` etc. in `public/style.css`, next to
   the existing synopsis rules (lines 1092-1102). Keep it lighter than the
   search-card context: smaller font (~0.8rem), 2-line clamp instead of 3,
   small top margin, and zero bottom margin (the existing `.synopsis` has
   `margin: 0 0 0.6rem` which would add stray space above the row's
   send-summary divider).
5. **Empty slot = invisible.** The slot `<div class="lib-blurb">` starts
   empty and only ever receives content when a description resolves. With
   `margin: 0` on the empty state (use `.lib-blurb:empty { display: none; }`
   for safety), a null description renders literally nothing — satisfying
   acceptance criterion 3 without conditional DOM surgery.

## Step-by-step tasks

All edits are in `public/app.js` and `public/style.css` only.

### Task 1 — Add `blurbCache`, `blurbObserver`, `loadBlurb`, `makeBlurbSlot` (public/app.js)

Place this block near the existing lazy-cover machinery (after
`loadCover`/`makeCoverPlaceholder`, around line 2120), so the two lazy-load
systems read side by side:

- `const blurbCache = new Map(); // 'title|author' (lowercased) -> description | null`
- `const blurbObserver = ('IntersectionObserver' in window) ? new IntersectionObserver((entries, obs) => { for (const entry of entries) { if (entry.isIntersecting) { obs.unobserve(entry.target); loadBlurb(entry.target); } } }, { rootMargin: '200px' }) : null;`
  — note **no `root` option** (viewport root; see decision 1).
- `async function loadBlurb(slot)`:
  - Read `slot.dataset.title` / `slot.dataset.author`; build
    `key = \`${title}|${author}\`.toLowerCase()`.
  - `let desc = blurbCache.get(key);`
  - If `desc === undefined`: build `URLSearchParams` with `title`/`author`
    (only when non-empty, matching `loadCover` at app.js:2098-2100), fetch
    `` `/api/meta?${params}` ``, take `data.description || null`; on any
    throw use `null`; then `blurbCache.set(key, desc)`.
  - If `desc && slot.isConnected`: `slot.append(buildSynopsis(desc))`.
    (Guard `slot.childElementCount === 0` before appending, so a stray
    double-invocation can't duplicate the synopsis.)
- `function makeBlurbSlot(title, author)`:
  - Return `null` immediately if both `title` and `author` are empty/blank
    (nothing to look up — mirrors `buildWatchCover`'s no-data branch at
    app.js:2818).
  - Otherwise create `el('div', { className: 'lib-blurb' })`, set
    `slot.dataset.title = title || ''`, `slot.dataset.author = author || ''`.
  - **Cached-hit fast path:** if `blurbCache.get(key)` is a string, append
    `buildSynopsis(...)` synchronously and return the slot **without
    observing** — this is what makes drawer re-opens paint instantly with no
    network call (criterion 5). If the cached value is `null` (known-empty),
    return the slot without observing or fetching.
  - Otherwise: `if (blurbObserver) blurbObserver.observe(slot); else loadBlurb(slot);`
    (the eager fallback for no-IO browsers, mirroring
    `renderLibraryCover`'s app.js:2226-2227).

Use the existing `el(tag, props, children)` helper as every other renderer in
this file does.

Verify: `node --check public/app.js` parses; nothing else calls these yet.

### Task 2 — Wire the slot into the Library row view (public/app.js, `renderLibraryBook`, ~line 2231)

In `renderLibraryBook`, the `.lib-main` column is built at app.js:2323-2328 as
`[lib-title, lib-author, metaline, sendSummary]`. Insert the blurb slot
**between `metaline` and `sendSummary`**:

```js
el('div', { className: 'lib-main' }, [
  el('h3', { className: 'lib-title' }, book.title || book.filename || 'Untitled'),
  book.author ? el('div', { className: 'lib-author' }, book.author) : null,
  metaline,
  makeBlurbSlot(book.title || '', book.author || ''),   // ← new
  sendSummary,
]),
```

Notes:
- `el(...)` (app.js:461-469) skips `null`/`undefined` children
  (`if (c == null) continue;`), so passing `makeBlurbSlot(...)`'s possible
  `null` straight into the children array is safe — verified, no
  `.filter(Boolean)` needed.
- Do **not** touch `renderLibraryGridCard` (~line 2168) — grid view is out of
  scope.
- Do **not** touch the skeleton renderer (`renderLibrarySkeleton`,
  app.js:2126) — the blurb arrives after real rows exist, so skeletons are
  unaffected.

Verify: open the Library drawer in a browser, row view — blurbs appear on
scroll (see Testing section).

### Task 3 — Wire the slot into the Watchlist rows (public/app.js, `renderWatchlist`, ~line 2682)

In `renderWatchlist`, the per-watch main column is built at app.js:2808:

```js
const main = el('div', { className: 'watch-row-main' }, [head, ...metaLines, recipLine, editor]);
```

Insert the slot after `head` (so the blurb sits directly under the
title/status line, above the checked/delivery meta):

```js
const main = el('div', { className: 'watch-row-main' }, [head, makeBlurbSlot(w.title || '', w.author || ''), ...metaLines, recipLine, editor]);
```

(`makeBlurbSlot` returns `null` for a watch with neither title nor author —
the "(any)" wildcard watches — so those rows get no slot at all.)

Verify: open the Watchlist modal — blurbs appear for watches whose
title/author resolve.

### Task 4 — CSS variant (public/style.css)

Add next to the existing synopsis block (after line 1102), keeping the
section-comment style used throughout the file:

```css
/* Row-context blurbs (Library rows + Watchlist) — lighter than the search-card
   synopsis: smaller type, 2-line clamp, no trailing margin. */
.lib-blurb { margin-top: 0.45rem; }
.lib-blurb:empty { display: none; margin: 0; }
.lib-blurb .synopsis { margin: 0; }
.lib-blurb .synopsis-text { font-size: 0.8rem; }
.lib-blurb .synopsis-text.clamped { -webkit-line-clamp: 2; }
.lib-blurb .synopsis-toggle { font-size: 0.75rem; }
```

Tune values by eye during manual verification, but keep the pattern: scope
everything under `.lib-blurb` so the search-card synopsis
(`renderLibraryHits`) and send-modal synopsis are pixel-identical to before.
Do not edit the base `.synopsis*` rules (style.css lines 1092-1102).

Verify: search-result "already own this" card synopsis looks unchanged;
library/watchlist blurbs are visibly smaller/tighter than the card version.

### Task 5 — Full verification pass

Run the automated tests and the manual browser checks in the next section.

## Data / model / API changes

**None.** Explicitly:

- No changes to `src/server.js` — `GET /api/meta` (lines 759-769) is consumed
  as-is (query params `title`, `author`; response
  `{ cover, description }`, both nullable; never throws HTTP errors — fails
  soft to nulls).
- No changes to `src/covers.js` — `resolveMeta` already disk-caches under
  `meta:`-namespaced keys in `covers-cache.json` and never throws.
- No schema, persistence, or `.env` changes. No new dependencies.
- No changes to the other `/api/meta`/`buildSynopsis` consumers:
  `renderLibraryHits` (app.js ~564-592), the send-modal enrichment
  (app.js ~694-698), and the server-side email path (server.js ~965).

## Testing & verification

### Automated

```bash
cd /home/eric/projects/bookhunt
node --check public/app.js     # syntax gate (app.js is plain browser JS, no bundler)
npm test                       # runs node --test test/*.test.js
```

`npm test` covers acceptance criterion 6. There are no frontend unit tests
(the only test touching `public/app.js` is `test/pwa.test.js`, which asserts
the service-worker shell list and absence of inline SW registration — neither
is affected). If any `test/lists.test.js` failures appear, check whether they
reproduce with your changes stashed — that file belongs to the untouched
prior feature.

No service-worker cache bump is needed: `public/sw.js` is network-first for
the shell (see its header comment); a normal refresh picks up new
`app.js`/`style.css`.

### Manual browser verification (criteria 1-5, 7)

Start the app with `npm start` (or `npm run dev`) and open it in a browser.
If the Playwright-based `webapp-testing` skill is available in your
environment, use it to drive these checks and capture screenshots; if you
cannot run a browser at all, say so explicitly in your report — do not claim
visual verification you didn't perform. Note: full search/download needs the
headed Mobilism browser session, but the Library/Watchlist UIs and
`/api/meta` only need the node server + existing data files, so plain
`npm start` should suffice for this feature.

1. **Library blurb + toggle (criterion 1):** open the Library drawer (row
   view). For a book with a real title/author, a 2-line clamped blurb appears
   under the metaline; clicking `more` expands it, `less` re-clamps. Confirm
   no layout flash: rows render immediately; the blurb slot fills in a moment
   later without reflowing the cover/title (a small push-down of the
   send-summary line as the blurb arrives is acceptable and matches how
   covers pop in).
2. **Watchlist blurb (criterion 2):** open the Watchlist modal; watches with
   resolvable title+author show the same collapsed blurb under the head line.
3. **Null description (criterion 3):** find (or temporarily add) a watch with
   a gibberish title (e.g. "zzqx qwertyplok"); its row must show no blurb
   element, no empty gap, no error. Also verify a watch with neither title
   nor author renders no slot.
4. **Laziness (criterion 4):** with a library of many books, open DevTools →
   Network, filter `meta`, open the Library drawer, and do **not** scroll:
   only the initially visible rows (+200px margin) fire `/api/meta` calls.
   Scroll down: further calls fire progressively. Total calls ≈ rows scrolled
   past, not total book count.
5. **Client cache (criterion 5):** close and reopen the Library drawer (and
   the Watchlist modal) — the Network tab shows **zero** new `/api/meta`
   calls for already-fetched keys, and cached blurbs paint immediately
   (synchronous fast path). Also toggle the library title/author filter to
   force a re-render and confirm no re-fetch.
6. **Console (criterion 7):** zero console errors throughout all of the
   above.
7. **Regression spot-checks:** grid view unchanged (no blurbs there); covers
   still lazy-load; search "already own this" card synopsis unchanged; the
   send modal's blurb enrichment unchanged; watch rows' Check now / pause /
   delete buttons still work (they trigger `loadWatchlist()` re-renders —
   good moments to observe the cache preventing re-fetches).

## Risks & watch-outs

- **Observer root choice.** Do not copy `coverObserver`'s
  `root: libraryList` — `#libraryList` is not the scroll container (its
  ancestor `.library-panel` is), and `#watchlistBody` is a different
  container again. Use the viewport (`root: null`) for the single shared
  `blurbObserver`, as decided above. If you instead choose per-surface roots,
  the Watchlist root must be `document.querySelector('#watchlistBody')` —
  which exists in `index.html` from page load (line 187) and is never
  replaced (only its `innerHTML` is cleared), so a module-level reference is
  safe — but the viewport root is simpler and correct for both.
- **Duplicate fetches / duplicate DOM.** `renderWatchlist` re-runs after
  every action (`loadWatchlist()` is called after check/pause/delete/save).
  Each re-render creates fresh slots; the old slots are discarded with the
  old DOM. Protections needed: (a) the `blurbCache` check inside `loadBlurb`
  so a re-observed key never re-fetches; (b) the `slot.isConnected` guard so
  a late response never paints into a detached node; (c) the cached-hit
  synchronous path in `makeBlurbSlot` so re-renders don't even go through the
  observer; (d) the `childElementCount === 0` guard against double-append.
  Note the same `title|author` key can appear in both Library and Watchlist —
  the shared cache makes that a feature (one fetch serves both), and per-slot
  appends keep the DOM independent.
- **In-flight de-dup is imperfect by design.** Two rows with the same key
  visible simultaneously *before* the first response lands will both fetch
  (cache is set only after the response). `loadCover` has the same property;
  the server disk cache makes the second call cheap. Do not build a
  promise-map de-dup layer — unnecessary complexity here.
- **Don't disturb other synopsis consumers.** All CSS changes must be scoped
  under `.lib-blurb`; `buildSynopsis` itself must not change (its 140-char
  toggle threshold and class names are shared with the search card and send
  modal).
- **Watchlist "(any)" watches** have no title/author — `makeBlurbSlot` must
  return `null` (no slot, no fetch) rather than firing a blank `/api/meta`
  call (the server would answer `{cover:null,description:null}` but it's a
  wasted request).
- **`prefillFromQuery` TDZ gotcha (repo memory):** `prefillFromQuery()` must
  remain the bottom of `app.js`. Add nothing after it; place all new code in
  the middle of the file as directed in Tasks 1-3.
- **Do not touch the pre-existing dirty files** listed at the top, and do not
  bump `package.json` version — already bumped by the other feature.
- **Description length:** Google Books descriptions can be long;
  `buildSynopsis` clamps display but the full text lands in the DOM — fine,
  no truncation needed (matches existing card behavior).

## Out of scope (restated from the brief — do not build these)

- Library **grid view** (`renderLibraryGridCard`) — tiles stay compact and
  art-forward; no blurbs there.
- Any backend change: no new endpoints, no `src/server.js` or `src/covers.js`
  edits, no schema/persistence changes, no cache-TTL or `cleanDescription`
  tuning.
- Any change to existing `buildSynopsis`/`/api/meta` consumers (search
  "already own this" card, send-modal enrichment, notification emails).
- Anything touching the goodreads-genre-lists files listed in the warning at
  the top of this plan.
- Committing or pushing — leave everything uncommitted unless the user
  explicitly asks.
