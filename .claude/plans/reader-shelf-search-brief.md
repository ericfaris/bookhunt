# Concept brief: Reader shelf search + "not found → watch" flow

## Problem
The reader portal (`/reader`, `public/reader.html` + `public/reader.js`, backed by
`src/reader.js`) only shows books acquired in the last `RECENT_DAYS` (30) days. A
reader who wants an older book already in BookHunt's library, or wants to ask for a
book BookHunt doesn't have at all, has no way to do either from their shelf — they'd
have to email the operator.

## Goal
Add a search box to the reader's shelf page that:
1. Searches BookHunt's existing library (all books ever acquired, not just the
   recent-30-day window) and shows matches the reader can send to their own Kindle,
   exactly like the existing shelf tiles.
2. If nothing matches, walks the reader through submitting a title + author to the
   watchlist, then confirms "we'll let you know when we find it."

## In scope
- A search input/box on `public/reader.html`, wired up in `public/reader.js`.
- A new reader-scoped API route, e.g. `GET /reader/api/search?t=...&q=...` (or
  separate `title`/`author` params — executor's call, follow the existing query-param
  style used elsewhere in the app, e.g. `public/app.js`'s title/author search form),
  that searches the **existing library only** — reuse `src/library.js`'s
  `buildLibrary` + `findInLibrary` (already used for the "you already own this"
  cross-reference elsewhere). **No live Mobilism scrape** — that's an operator-only,
  heavier action and out of scope here.
  - Results should be restricted to books that are actually sendable: `verified &&
    filePresent`, matching the filter `recentBooks()` already applies in
    `src/reader.js` (a reader shouldn't be offered a "Send to Kindle" button for a
    book that isn't really there).
  - Reuse the same tile rendering / send-to-Kindle flow already in `public/reader.js`
    for search results (don't build a second parallel UI for search hits — the
    existing `.tile` markup + `POST /reader/api/send` flow should just work against
    search-result book ids).
- A new reader-scoped API route, e.g. `POST /reader/api/watchlist`, that:
  - Accepts `{ t, title, author }` from the no-results state.
  - Resolves the recipient via `reader.byToken(t)` (existing pattern — same as
    `/reader/api/books` and `/reader/api/send`).
  - Adds a watch via `src/watchlist.js`'s `add()`/`cleanWatchInput()`, with
    `recipientIds: [recipient.id]` so the reader (and only the reader — see decision
    below) gets notified through the *existing* watcher-fulfilled email flow
    (`src/watcher.js` → `notify.notify(recipient, ...)`), not the reader-portal "new
    books" email.
  - **Important existing-code gotcha to handle**: `watchlist.add()` dedupes by
    `queryKey(title,author)` — if an ACTIVE watch for the same query already exists
    (e.g. the operator is already watching it), `add()` returns the existing watch
    **unchanged**, silently ignoring the new `recipientIds`. If the route naively
    calls `watchlist.add()`, a reader could ask to be watched for a book someone else
    is already watching and never get notified. The route must handle this: e.g.
    look up whether an active watch with the same `queryKey` already exists first
    (`watchlist.readAll()` + `watchlist.queryKey()`), and if so, merge the reader's id
    into its `recipientIds` via `watchlist.setRecipients()` (dedupe is already handled
    inside `cleanRecipientIds`) instead of relying on `add()`'s silent short-circuit.
    Otherwise call `watchlist.add()` normally for a fresh watch.
  - Basic validation: require at least a title or author (mirror
    `watchlist.cleanWatchInput`'s existing rule — it already throws if both are
    blank), keep the existing input length caps (`MAX_LEN`), no new caps needed.
- Client-side UX in `public/reader.js` / `public/reader.html`:
  - A search box (title/author, simplest is a single free-text field like the
    operator dashboard, or split title/author fields — executor's call, but favor
    simplicity given the reader audience is non-technical).
  - On search: show matching tiles (reuse tile-rendering code) if any.
  - On no matches: show a small inline form to confirm/edit title + author (pre-filled
    from the search box) and submit to the watch endpoint.
  - On successful watch add: **one-time confirmation only** — an inline message like
    "We'll email you when we find it 📬" — no persistent "currently watching" list on
    the shelf page (explicitly out of scope, see below). No polling, no watch
    management UI for readers.
  - Style: follow the existing reader.html look (warm cream / navy theme, existing
    `.note`, `.tile`, `button.send` classes) — this page is intentionally
    non-technical and cozy, don't introduce a different visual language.
- Tests: add coverage in `test/reader.test.js` (or a new test file if that one is
  large) for the new pure/route-level logic — at minimum: search-library matching
  (verified/filePresent filtering), and the "merge recipientIds into an existing
  active watch vs. create a new one" branch, since that's the one non-obvious piece
  of logic. Follow this repo's existing pattern of testing PURE helpers directly
  rather than only through HTTP.

## Out of scope
- Live Mobilism/forum search from the reader UI (operator-dashboard-only capability,
  stays that way).
- A persistent "watches I'm waiting on" list/section on the reader shelf.
- Notifying the operator in addition to the reader when a reader-added watch is
  fulfilled (reader-only, per decision below).
- Any change to how the *operator* dashard's search/watchlist UI (`public/app.js`)
  works — this is reader-portal only.
- Rate-limiting changes beyond what already exists (`/reader` and `/reader/api` are
  already rate-limited in `src/server.js`; the new routes just need to sit under the
  same `app.use('/reader', ...)` middleware, no new limiter needed unless the
  executor sees a specific abuse vector, e.g. watch-spam — if so, a small dedicated
  throttle mirroring `sendAllowed()`'s pattern in `src/reader.js` is acceptable but
  should stay minimal).

## Constraints
- Must reuse `src/library.js` (`buildLibrary`, `findInLibrary`) and `src/watchlist.js`
  (`cleanWatchInput`, `add`, `setRecipients`, `queryKey`, `readAll`) rather than
  reimplementing matching/watch logic.
- Must reuse `reader.byToken()` for auth on any new route — no new auth mechanism.
- New routes live under `/reader/api/*` so they inherit the existing CF Access bypass
  + rate limiter already wired up in `src/server.js` (see `app.use('/reader', ...)`
  and `app.use('/reader/api', ...)` around line 69-100).
- No new npm dependencies expected — this is composition of existing modules.
- Match existing code style: CommonJS, small PURE helpers exported for tests where
  practical (this repo consistently does that — see `library.js`, `watchlist.js`,
  `reader.js` itself).

## Acceptance criteria
1. From `/reader?t=<validtoken>`, a reader can type a title/author into a new search
   box and see matching books from the *entire* library (not just the last 30 days),
   each with a working "Send to my Kindle" button that behaves like the existing
   shelf tiles.
2. Search results only include books that are `verified && filePresent` (no dead
   "send" buttons for books that no longer exist on disk).
3. Searching for a title/author with no library match shows a clear "not found" state
   with a way to submit that title/author to the watchlist.
4. Submitting the not-found form creates (or joins) an ACTIVE watch in
   `watchlist.json` whose `recipientIds` includes this reader's recipient id — verify
   both the "brand new watch" path and the "an active watch for this query already
   existed" path (the latter must still end with the reader's id present in
   `recipientIds`).
5. After submitting, the reader sees a one-time confirmation message and no
   persistent watch-list UI appears on the shelf.
6. A request to the search or watchlist-add routes with an invalid/missing token
   behaves like the existing `/reader/api/books` and `/reader/api/send` routes on bad
   tokens (404/consistent-timing, no information leak) — reuse `reader.byToken`'s
   existing behavior, don't special-case it.
7. `npm test` passes, including new tests for the library-search filtering and the
   merge-vs-create watch logic.

## Open questions & decisions made
- Plan review: **user wants to review the Opus plan before execution begins.**
- Search scope: **existing library only**, no live Mobilism scrape from the reader
  side.
- Watch notify target: **the reader only** (not also the operator).
- Post-watch UX: **one-time confirmation only**, no persistent watching list.
- Search result restriction to `verified && filePresent`: decided by Claude (this
  session) during grounding, not explicitly asked — flagged here so the plan reviewer
  can override if wrong. Rationale: matches the existing `recentBooks()` filter and
  avoids offering a "Send" button that will fail.
- The `watchlist.add()` silent-dedupe-without-merging-recipientIds behavior is a
  pre-existing quirk in `src/watchlist.js` (not a bug introduced by this feature) —
  the brief above tells the executor how to work around it in the new route rather
  than modifying `add()`'s existing contract (which the operator dashboard also
  depends on).

## Relevant files/areas
- `public/reader.html` — shelf page markup/styles.
- `public/reader.js` — shelf page client logic (fetch `/reader/api/books`, render
  tiles, send-to-Kindle flow, install hint).
- `src/reader.js` — reader-portal backend module (`byToken`, `booksForReader`,
  `recentBooks`, `sendToReader`, email builders). New search/watch functions likely
  belong here, following the existing PURE-helper-plus-export pattern.
- `src/server.js` — routes around lines 69-140 (`/reader`, `/reader/app.js`,
  `/reader/api/books`, `/reader/api/send`, `/reader/api/unsubscribe`) — new routes go
  here, under the same `/reader` and `/reader/api` middleware.
- `src/library.js` — `buildLibrary`, `findInLibrary` (library-wide search + "owns
  this" matching), `LIBRARY_TITLE_THRESHOLD`.
- `src/watchlist.js` — `cleanWatchInput`, `add`, `setRecipients`, `cleanRecipientIds`,
  `queryKey`, `readAll`.
- `src/watcher.js` — how a fulfilled watch's `recipientIds` gets emailed (context
  only, not expected to change).
- `test/reader.test.js` — existing reader-module tests; extend here.
- `public/app.js` lines ~811-842 — the operator dashboard's "Watch this search"
  button, useful as a UX/API-shape reference (not to be modified).

## Repo commands & tree state
- Test: `npm test` (runs `node --test test/*.test.js`, plain Node, no venv/bundler
  needed — Node itself is on `PATH`).
- Dev run: `npm run dev` (`node --watch src/server.js`) or `npm start`.
- Rebuild/redeploy for the Docker lab (not needed until Phase 6): `npm run
  docker:up` — NOT plain `docker compose`, per repo convention (stamps
  version/commit/build-time).
- Working tree was **clean** at the start of this session (`git status --short`
  produced no output). No pre-existing uncommitted changes to account for.
