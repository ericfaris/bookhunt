# Concept Brief: Book Blurbs in Library & Watchlist

## Problem

The Library and Watchlist views show title/author/cover/status for each book
but no synopsis/description. The user wants a short blurb visible per book in
both places so they can recall/recognize a book without opening an external
link.

## Goal

Show a collapsed-by-default book blurb (synopsis) on Library rows and
Watchlist rows, lazily fetched so it doesn't hammer the Google Books API on
page load.

**Key finding from research: most of the backend already exists.** This is
primarily a frontend wiring task, not a new feature build:

- `src/covers.js` already has `resolveMeta({title, author})` — cache-backed
  (disk cache `covers-cache.json`, namespaced under a `meta:` key), calls
  `descriptionFromGoogleBooks` + `cleanDescription`, fails soft (returns
  `null` description rather than throwing).
- `GET /api/meta?title=&author=` (`src/server.js:759-767`) already returns
  `{ cover, description }` end-to-end.
- `public/app.js` already has `buildSynopsis(text)` (line 719) — a
  collapsible clamp-to-140-chars-with-more/less-toggle renderer — currently
  used only by the search "already own this" card (`renderLibraryHits`,
  ~line 564-592) and in the send-modal enrichment (~line 694-698).
- The cover-lazy-load pattern to mirror: `coverObserver`
  (`IntersectionObserver`, app.js:2079) + `loadCover(holder)` (app.js:2090) —
  placeholder divs carry `dataset.title`/`dataset.author`, get observed, and
  fetch `/api/cover` only once scrolled into view.

So the task is: add a similar lazy-fetch-and-render path for `/api/meta`'s
`description` field into `renderLibraryBook` (row view) and `renderWatchlist`
(row view), reusing `buildSynopsis` for the display and a
`coverObserver`-like `IntersectionObserver` for the fetch trigger. No new
backend endpoint, no new external API integration, no new persistence.

## In scope

- Library **row view** (`renderLibraryBook`, `public/app.js` ~line 2231):
  lazily fetch and render a collapsed blurb via `buildSynopsis`.
- Watchlist rows (`renderWatchlist`, `public/app.js` ~line 2682): same.
- A lazy-load mechanism (new `IntersectionObserver`, or extending the
  existing `coverObserver` callback to also trigger a blurb fetch) so blurbs
  only fetch for on-screen rows — mirroring how covers already behave.
- Client-side caching of fetched blurbs (mirror `coverCache`, a
  title|author-keyed `Map`) so re-renders (e.g. after a filter/sort change)
  don't re-fetch.
- Graceful "no blurb found" handling: if `/api/meta` returns no description,
  render nothing (no empty box, no error), consistent with how missing
  covers fall back to a placeholder rather than erroring.

## Out of scope

- Library **grid view** (`renderLibraryGridCard`) — explicitly skipped per
  user decision; tiles stay compact/art-forward as designed in the v1.17.0
  redesign.
- Any new backend endpoint, schema, or persistence change — `/api/meta` and
  `resolveMeta`/`covers-cache.json` already do everything needed.
- Any change to the existing consumers of `buildSynopsis`/`/api/meta`
  (search "already own this" card, send-modal enrichment, notification
  emails) — those stay exactly as they are.
- Any change to `src/covers.js` internals (Google Books client, cache TTL,
  cleanDescription logic) unless a real bug is found during implementation —
  this is a UI wiring task against an existing, working API.
- Any change to the goodreads-genre-lists work from the prior session (see
  "Repo commands & tree state" below) — unrelated, do not touch those files.

## Constraints

- Must reuse `buildSynopsis(text)` as-is (don't fork or duplicate the
  clamp/toggle logic).
- Must reuse the `/api/meta?title=&author=` endpoint as-is — no backend
  changes.
- Must follow the existing lazy-load convention: placeholder element with
  `dataset.title`/`dataset.author`, observed by an `IntersectionObserver`
  scoped to the relevant scroll container (`libraryList` for Library,
  presumably the watchlist body/container — confirm the right root element
  for a Watchlist-specific observer, since `coverObserver`'s root is
  `libraryList` and Watchlist has its own container `#watchlistBody`).
- Should degrade the same way covers do when `IntersectionObserver` isn't
  supported (fetch immediately as a fallback) — see `renderLibraryCover`'s
  `else loadCover(holder)` branch for the pattern.
- Keep visual weight modest: the blurb should not visually dominate the row
  the way it might in the search-result card context; consider whether the
  existing `.synopsis`/`.synopsis-text`/`.synopsis-toggle` CSS classes need a
  row-scoped variant/tweak (check `public/style.css` or equivalent for
  existing `.synopsis` rules) versus reusing them unchanged.

## Acceptance criteria

1. Scrolling the Library (row view) into view for a book with a known
   Google Books description shows a collapsed (clamped) synopsis with a
   "more" toggle that expands/collapses it — no layout jump/flash on
   initial load (skeleton/placeholder rows already exist; blurb should not
   break that).
2. Scrolling the Watchlist shows the same collapsed synopsis per watch that
   has title+author data resolvable to a description.
3. A book/watch with no matching description (API returns null) renders no
   blurb element at all — not an empty box, not an error message.
4. No blurb `/api/meta` calls fire for rows that never scroll into view
   (verify via Network tab during manual testing: row count of `/api/meta`
   calls ≈ number of rows actually scrolled past, not total book count for
   a long library).
5. Repeated open/close of the Library or Watchlist drawer/panel does not
   re-fetch a blurb already cached client-side for the same title|author
   key.
6. `npm test` still passes (no backend changes expected, but confirm
   nothing broke).
7. Manually verified in a browser: open Library, open Watchlist, scroll,
   observe blurbs appearing, toggle more/less, confirm no console errors.

## Open questions & decisions made

- **Plan review**: user chose to skip the plan-approval gate again — Sonnet
  (this session) will sanity-check Fable's plan itself and proceed straight
  to the Opus build without pausing for confirmation, unless the plan looks
  seriously wrong.
- **Placement**: both Library row view and Watchlist rows, collapsed by
  default (reusing `buildSynopsis`) — confirmed with user.
- **Lazy loading**: yes, IntersectionObserver-based like covers, not eager
  fetch-on-load — confirmed with user.
- **Grid view**: explicitly out of scope — confirmed with user.

## Relevant files/areas

- `public/app.js`:
  - `buildSynopsis` (~line 719) — reuse as-is.
  - `renderLibraryBook` (~line 2231) — add blurb slot + lazy fetch here.
  - `renderLibraryCover` / `coverObserver` / `loadCover` (~lines 2077-2229)
    — the pattern to mirror for a new blurb observer/loader.
  - `renderWatchlist` (~line 2682) — add blurb slot + lazy fetch here.
  - `coverCache` (search for its declaration) — mirror for a `metaCache`/
    `blurbCache`.
  - Existing `/api/meta` consumers for reference on request shape:
    `renderLibraryHits` (~line 564-592) and the send-modal enrichment
    (~line 694-698).
- `src/server.js` — `GET /api/meta` (~lines 759-767): read-only reference,
  no changes expected.
- `src/covers.js` — `resolveMeta`, `descriptionFromGoogleBooks`,
  `cleanDescription`: read-only reference, no changes expected.
- CSS file (find the stylesheet — likely `public/style.css` or similar) —
  check existing `.synopsis`/`.synopsis-text`/`.synopsis-toggle` rules and
  whether a row-context tweak is needed for Library/Watchlist rows
  (spacing, font-size) versus the search-card context they were built for.

## Repo commands & tree state

- Test runner: `npm test` (runs `node --test test/*.test.js`). Node/npm are
  on `PATH` directly, no venv/wrapper needed.
- Dev server: `npm start` / `npm run dev` if the executor wants to manually
  eyeball the UI (needs a browser — check whether Playwright/webapp-testing
  tooling is available in the executor's environment for a manual check;
  if not, static code review + `npm test` is the fallback, and the executor
  should say so explicitly rather than claim it visually verified something
  it didn't).
- Git tree state at brief-writing time is **NOT clean** — there are
  pre-existing uncommitted changes from a prior, unrelated feature (Amazon
  → Goodreads genre-list source swap, done in an earlier session):
  ```
   M .env.example
   M package.json
   M src/lists.js
   D src/listsources/amazon.js
   M src/listsources/goodreads.js
   M src/listwatcher.js
   M test/lists.test.js
  ?? .claude/plans/goodreads-genre-lists-brief.md
  ?? .claude/plans/goodreads-genre-lists-plan.md
  ```
  These are NOT part of this task — do not attribute them to this work, do
  not revert them, and do not commit them. The executor should leave them
  untouched and only add/stage its own new changes (e.g.
  `public/app.js`, possibly a CSS file, and this task's own
  brief/plan docs) without touching the files listed above. Do not commit
  or push anything (neither the pre-existing changes nor the new ones)
  unless the user explicitly asks. Current branch: `main`.
