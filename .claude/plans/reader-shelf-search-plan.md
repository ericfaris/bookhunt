# Implementation plan: Reader shelf search + "not found → watch" flow

Executor note: you have only this file and the repo. Read the referenced files
before editing. Do **not** modify the operator dashboard (`public/app.js`) or
`watchlist.add()`'s existing contract. This is reader-portal only.

## Summary

The reader portal (`/reader`) currently shows each reader only the books
acquired in the last `RECENT_DAYS` (30) days (`src/reader.js` `recentBooks`).
This adds a search box to the shelf that (1) searches BookHunt's **entire**
existing library (all books ever acquired) and renders sendable matches as the
same tiles with the same "Send to my Kindle" flow, and (2) when nothing matches,
walks the reader through submitting a title/author to the watchlist so they get
emailed when BookHunt finds it. It is pure composition of existing modules
(`src/library.js`, `src/watchlist.js`, `src/reader.js`) behind two new
`/reader/api/*` routes — no live Mobilism scrape, no new deps, no new auth.

## Approach & key decisions

- **Search is library-only.** Reuse `library.buildLibrary` +
  `library.findInLibrary` (already used by the operator search's "you already
  own this" stage in `src/server.js` ~line 260-269). No forum scrape from the
  reader side — that stays operator-only.
- **Sendable filter.** Restrict search results to `verified && filePresent`,
  matching what `reader.recentBooks()` already enforces, so a reader is never
  offered a "Send" button for a book that isn't on disk. (Decision carried from
  the brief; matches the existing shelf invariant.)
- **One free-text box, matched against title AND author.** The reader audience
  is non-technical, so a single field is friendlier than split title/author
  inputs. To still support "search by author", the server runs `findInLibrary`
  twice — once as `{ title: q }`, once as `{ author: q }` — and merges results
  (dedupe by book id, title-hits first). Rejected: passing `q` as both title and
  author in one `findInLibrary` call — that ANDs the two conditions (title must
  score AND author must corroborate), which is too strict and would match almost
  nothing. Rejected: split title/author fields — more UI for little reader
  benefit.
- **Reuse the existing tile + send flow.** Extract the tile-rendering and
  send-button wiring already inline in `public/reader.js` into a reusable
  function so search hits render identically and POST to the existing
  `/reader/api/send` route against the search-result book `id`. No second UI.
- **Reader-only watch notification.** The watch is added with
  `recipientIds: [recipient.id]` so the reader (and only the reader) is notified
  through the existing watcher-fulfilled email path (`src/watcher.js` →
  `notify.notify`). The operator is *not* added.
- **Work around `watchlist.add()`'s silent dedupe.** `add()` short-circuits when
  an ACTIVE watch with the same `queryKey` exists and returns it **unchanged**,
  dropping the new `recipientIds`. So a reader could ask to be watched for a book
  the operator already watches and never get notified. The new route must, when
  an active watch with the same `queryKey` already exists, **merge** the reader's
  id into that watch's `recipientIds` via `watchlist.setRecipients()` instead of
  calling `add()`. Isolate this decision in a PURE helper (`planReaderWatch`)
  that returns "merge existing id X" vs "create new", so it's unit-testable
  without the filesystem. Do **not** change `add()` — the operator dashboard
  depends on its current behavior.
- **One-time confirmation, no watch-management UI.** After a successful add, show
  an inline "We'll email you when we find it 📬" and stop. No persistent
  "watching" list, no polling.
- **Auth/rate-limit reuse.** New routes live under `/reader/api/*`, inheriting
  the existing CF Access bypass + `rateLimiter({ max: 40 })` + `no-store`
  middleware in `src/server.js` (lines 70-77). Auth is `reader.byToken(t)`,
  exactly like `/reader/api/books` and `/reader/api/send`; bad tokens 404 with
  no new special-casing. No new limiter is needed — the existing per-reader send
  throttle (`sendAllowed`) already bounds the only expensive action (sends);
  search and watch-add are cheap. (If you judge watch-spam a real vector, a
  minimal throttle mirroring `sendAllowed` is acceptable, but default to not
  adding one.)

## Step-by-step tasks

Do these in order. Each is independently verifiable via `npm test` and/or manual
inspection.

### 1. `src/reader.js` — pure search helper

Add a PURE, exported helper that takes the full library and a free-text query
and returns the sendable matches, best-first, deduped:

```
/** PURE: reader-facing library search. Restricts to sendable books
 *  (verified && filePresent), then matches the free-text query against BOTH
 *  title and author (findInLibrary once each), merging results with title hits
 *  first and each book at most once. Empty/blank query → []. */
function searchLibrary(books, query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const sendable = (books || []).filter((b) => b.verified && b.filePresent);
  const byTitle  = library.findInLibrary(sendable, { title: q }, opts);
  const byAuthor = library.findInLibrary(sendable, { author: q }, opts);
  const seen = new Set();
  const out = [];
  for (const b of [...byTitle, ...byAuthor]) {
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    out.push(b);
  }
  return out;
}
```

`library` is already required at the top of `src/reader.js`. `opts` is forwarded
to `findInLibrary` purely so tests can inject `matchScore`/`authorMatches` if
desired; production callers omit it. Export `searchLibrary` in the
`module.exports` (in the "exported for unit tests" block).

### 2. `src/reader.js` — extract a reusable reader-tile mapper

`booksForReader` (lines 161-180) maps a library book to the safe reader payload
(id, title, author, cover, tags, sent) with async cover resolution. Extract that
per-book mapping into a helper so the search route reuses it verbatim:

```
async function toReaderTile(b, recipient) {
  let cover = b.cover || null;
  if (!cover) {
    try { cover = await covers.resolveCover({ title: b.title, author: b.author }); } catch { /* placeholder */ }
  }
  return {
    id: b.id,
    title: b.title || b.filename || 'Untitled',
    author: b.author || '',
    cover,
    acquiredAt: b.acquiredAt,
    tags: b.tags || [],
    sent: sentTo(b, recipient),
  };
}
```

Rewrite `booksForReader` to `return Promise.all(recent.map((b) => toReaderTile(b, recipient)))`
(or a simple for-loop calling it) — behavior unchanged. This keeps the existing
reader-shelf tests passing and gives the search route the identical payload
shape. Export `toReaderTile` is optional (not required for tests).

### 3. `src/reader.js` — a search entry point for the route

Add a thin async function the route calls, so the route stays declarative:

```
async function searchForReader(recipient, query) {
  const hits = searchLibrary(buildBooks(), query);
  const out = [];
  for (const b of hits) out.push(await toReaderTile(b, recipient));
  return out;
}
```

`buildBooks()` already exists (line 135) and builds the library from
`history.readAll()` with real disk-presence via `booktags`/`covers`. Note:
`buildBooks()` uses the default `fileExists = () => true` from `buildLibrary`
(it passes the tags callback as the 2nd arg, not a file check) — so `filePresent`
here reflects `buildLibrary`'s default. **Verify this matches how `recentBooks`
already behaves** (it does — `recentBooks` filters the output of the same
`buildBooks()`), so the sendable filter in `searchLibrary` is consistent with the
existing shelf. Do not change `buildBooks`. Export `searchForReader`.

### 4. `src/reader.js` — pure merge-vs-create watch planner

Add the PURE helper that encodes the non-obvious watchlist logic (this is the
key thing to unit-test):

```
/** PURE: decide how a reader's watch request maps onto the existing watchlist.
 *  If an ACTIVE watch already exists for this query, return a merge (the
 *  reader's id added to its recipientIds); otherwise return a create. Works
 *  around watchlist.add()'s silent dedupe that would drop the new recipientId. */
function planReaderWatch(watches, cleaned, recipientId) {
  const key = watchlist.queryKey(cleaned);
  const existing = (watches || []).find((w) => w.status === 'active' && watchlist.queryKey(w) === key);
  if (existing) {
    return { action: 'merge', id: existing.id, recipientIds: [...(existing.recipientIds || []), recipientId] };
  }
  return { action: 'create', input: cleaned };
}
```

Add `const watchlist = require('./watchlist');` near the other requires at the
top of `src/reader.js` (watchlist does not require reader, so no cycle). Export
`planReaderWatch`. `setRecipients`/`cleanRecipientIds` already dedupe the merged
array, so pushing a possibly-duplicate id is safe.

### 5. `src/server.js` — new `GET /reader/api/search` route

Add alongside the other reader routes (after `/reader/api/books`, before or
after `/reader/api/send`, i.e. around line 118-133). Follow the `books` route's
auth + error shape exactly:

```
app.get('/reader/api/search', async (req, res) => {
  const r = reader.byToken(String(req.query.t || ''));
  if (!r) return res.status(404).json({ error: 'Not found' });
  const q = String(req.query.q || '').slice(0, 300).trim();
  try {
    const books = q ? await reader.searchForReader(r, q) : [];
    res.json({ name: r.name, kindleSet: !!r.kindleEmail, books, query: q });
  } catch (err) {
    console.error('Reader search failed:', err);
    res.status(500).json({ error: 'Search failed.' });
  }
});
```

The `.slice(0, 300)` mirrors watchlist's `MAX_LEN` cap and blunts oversized
input. Returning `kindleSet` lets the client disable send buttons on search hits
the same way the shelf does.

### 6. `src/server.js` — new `POST /reader/api/watchlist` route

Add after the search route:

```
app.post('/reader/api/watchlist', (req, res) => {
  const { t, title, author } = req.body || {};
  const r = reader.byToken(String(t || ''));
  if (!r) return res.status(404).json({ error: 'Not found' });
  try {
    const cleaned = watchlist.cleanWatchInput({ title, author, recipientIds: [r.id] });
    const plan = reader.planReaderWatch(watchlist.readAll(), cleaned, r.id);
    if (plan.action === 'merge') watchlist.setRecipients(plan.id, plan.recipientIds);
    else watchlist.add(plan.input);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not add the watch.' });
  }
});
```

`cleanWatchInput` already throws "Enter a title and/or an author to watch" when
both are blank (→ 400), and enforces `MAX_LEN`. `watchlist` is already required
in `src/server.js` (line 30). No `ownsBook` guard is needed here: the reader only
reaches this form after search returned no library match, so by construction they
don't own it; adding the guard would be harmless but is out of the reuse set the
brief specifies — leave it out to keep the route minimal.

### 7. `public/reader.html` — search box markup + styles

Insert a search form between `#banner` and `#install` (or directly above
`#main`). Keep the warm cream/navy language and reuse existing tokens
(`--surface`, `--border`, `--accent`). Suggested markup:

```
<form id="searchForm" class="search" hidden>
  <input id="searchInput" type="search" placeholder="Search all books by title or author…"
         autocomplete="off" maxlength="300" enterkeyhint="search">
  <button type="submit" class="add">Search</button>
</form>
<div id="searchResults"></div>
```

Add CSS mirroring existing controls (input styled like a `.note`, button like the
existing `.note button.add`). Example:

```
.search { display: flex; gap: 8px; margin: 0 0 16px; }
.search input { flex: 1; min-width: 0; background: var(--surface); color: var(--text);
  border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; font-size: 0.95rem; }
.search button.add { border: 0; border-radius: 10px; padding: 0 16px; font-weight: 600;
  cursor: pointer; background: var(--accent); color: #fff; }
.search button.add:hover { background: var(--accent-hover); }
#searchResults .center { text-align: center; padding: 24px 10px; color: var(--dim); }
```

Reuse the existing `.grid`, `.tile`, `.cover`, `button.send`, `.note`, `.err`
classes for results — do not introduce new visual language.

### 8. `public/reader.js` — refactor tile rendering to a shared function

The shelf-tile construction + send-button wiring is inline in the IIFE (lines
55-93). Extract it into a function reachable by both the shelf render and the
search render, capturing the `t` token and the current `kindleSet`:

```
function renderTile(b, t, kindleSet, el) {
  // ...the existing cover / err / btn / onclick block, unchanged,
  // returning the `.tile` div. btn.disabled = b.sent || !kindleSet.
}
```

`el` and the send `fetch('/reader/api/send', …)` call are already defined/used in
the IIFE — pass `el` in (or define `renderTile` inside the IIFE so it closes over
`el`). The send POST body stays `{ t, id: b.id }`; nothing about `/reader/api/send`
changes — it already resolves any library book id, not just recent ones (it looks
up the download entry by id in `history.readAll()`, see `reader.sendToReader`).

Rewrite the existing shelf grid loop (lines 55-93) to call `renderTile` so the
shelf and search share one code path.

### 9. `public/reader.js` — wire up search + not-found watch flow

After the shelf renders, reveal `#searchForm` and handle submit:

- On submit: read `#searchInput` value; if blank, clear results and return.
- `fetch('/reader/api/search?t=' + encodeURIComponent(t) + '&q=' + encodeURIComponent(q))`.
- Render into `#searchResults`:
  - **Hits:** a heading like "Found in the library" + a `.grid` of
    `renderTile(b, t, data.kindleSet, el)`.
  - **No hits:** a `.note` "not found" state with a small inline form pre-filled
    from the query — a title field (default = query) and an author field
    (default = blank), plus a "Ask BookHunt to find it" button. On submit, POST
    `{ t, title, author }` to `/reader/api/watchlist`; on success replace the form
    with the one-time confirmation `We'll email you when we find it 📬`; on error
    show `.err` with the returned message.
- Handle fetch/HTTP errors like the existing shelf load does (a friendly inline
  message, no stack).
- Do **not** add any persistent "watches you're waiting on" list, polling, or
  watch-management UI.

Keep the search results visually separate from the recent-shelf grid (own
container `#searchResults`), so searching doesn't disturb the shelf below.

### 10. `test/reader.test.js` — new tests

Extend the existing file (it's small). Add:

- **`searchLibrary` filtering + matching:** build a small `books` array with
  mixed `verified`/`filePresent` and a couple of realistic titles/authors; assert
  a title query returns only the `verified && filePresent` match(es) and excludes
  unverified / file-gone books; assert an author-name query returns that author's
  book; assert a blank query returns `[]`; assert dedupe (a book matching by both
  title and author appears once). Import `searchLibrary` from `../src/reader`.
  `library.findInLibrary` uses the real `matchScore`/`authorMatches`, which are
  deterministic and filesystem-free, so no stubbing is needed — pick titles
  distinct enough to score cleanly (e.g. "Theo of Golden" / "Allen Levi").
- **`planReaderWatch` merge-vs-create:** the non-obvious logic.
  - Create path: `planReaderWatch([], cleaned, 'r1')` →
    `{ action: 'create', input: cleaned }`.
  - Merge path: given `watches = [{ id:'w1', status:'active', title, author,
    recipientIds:['op'] }]` and a `cleaned` with the same title/author,
    `planReaderWatch(watches, cleaned, 'r1')` → `{ action:'merge', id:'w1',
    recipientIds:['op','r1'] }`. Build `cleaned` via
    `watchlist.cleanWatchInput({ title, author, recipientIds:['r1'] })` so
    `queryKey` alignment is realistic.
  - Non-active guard: a `status:'paused'`/`'fulfilled'` watch with the same query
    must NOT merge → returns `create` (a fresh active watch), proving a stale
    watch doesn't absorb the reader silently.

Do not add HTTP-level tests unless trivial — the repo pattern tests pure helpers
directly (see the existing `recentBooks`/`sendAllowed` tests).

## Data / model / API changes

No schema migrations. New endpoints only:

- `GET /reader/api/search?t=<token>&q=<free text>` → `200 { name, kindleSet,
  query, books: [{ id, title, author, cover, acquiredAt, tags, sent }] }` (same
  book shape as `/reader/api/books`); `404 { error:'Not found' }` on bad/missing
  token; `500 { error:'Search failed.' }` on internal error.
- `POST /reader/api/watchlist` body `{ t, title, author }` → `200 { ok:true }`;
  `404 { error:'Not found' }` on bad token; `400 { error }` on validation failure
  (both title+author blank, etc.).

`watchlist.json` entries are unchanged in shape. A reader-created watch is a
normal active watch with `recipientIds:[<reader recipient id>]`; a merge adds the
reader's id to an existing active watch's `recipientIds`. No new fields (do not
add a `source:'reader'` tag unless you also handle it in `dueWatchesMixed` — out
of scope; leave `source` unset so it behaves as a hand-added watch).

New exports from `src/reader.js`: `searchLibrary`, `searchForReader`,
`planReaderWatch` (and optionally `toReaderTile`).

## Testing & verification

Run the suite (plain Node, no bundler/venv): `npm test`
(`node --test test/*.test.js`).

Acceptance-criteria mapping:

1. **Search whole library, working send button** — manual: `npm run dev`, open
   `http://localhost:3000/reader?t=<validtoken>`, search a title acquired >30
   days ago, confirm it appears and "Send to my Kindle" behaves like a shelf
   tile. Unit: `searchLibrary` returns matches independent of `acquiredAt`.
2. **Only `verified && filePresent`** — unit test asserts unverified / file-gone
   books are excluded from `searchLibrary`.
3. **No-match → watch affordance** — manual: search a nonsense string, confirm
   the "not found" state with the watch form appears.
4. **Watch add creates or joins an ACTIVE watch with the reader's id** — unit:
   `planReaderWatch` create + merge + non-active branches. Manual/integration:
   POST to `/reader/api/watchlist` and inspect `watchlist.json` — new query →
   new active watch with `recipientIds:[readerId]`; pre-existing active watch for
   the same query → same watch now includes the reader id. Quick curl:
   `curl -s "http://localhost:3000/reader/api/watchlist" -H 'Content-Type: application/json' -d '{"t":"<token>","title":"Some Book","author":"Some Author"}'`
   then `cat watchlist.json`.
5. **One-time confirmation, no persistent list** — manual: after submit, only the
   inline confirmation shows; reload → no watch list on the shelf.
6. **Bad token parity** — manual/curl: hit both new routes with a bogus `t` and
   confirm `404 { error:'Not found' }`, same as `/reader/api/books`:
   `curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:3000/reader/api/search?t=bogus&q=x"` → `404`.
7. **`npm test` green**, including the new tests.

## Risks & watch-outs

- **The `add()` silent-dedupe trap is the whole point of task 4.** If you call
  `watchlist.add()` naively for the reader, a reader asking to watch a query the
  operator already watches will be silently dropped from notification. Always go
  through `planReaderWatch` → `setRecipients` on the merge branch. Do NOT "fix"
  `add()` itself — the operator route relies on its current return-existing
  behavior.
- **`findInLibrary` ANDs title+author within a single call.** Do not pass the
  free-text query as both `title` and `author` in one call. Run two calls (title,
  then author) and merge — that's task 1.
- **Cover resolution can be slow/throw.** `toReaderTile` already wraps
  `covers.resolveCover` in try/catch; keep that. Don't let a cover failure fail
  the whole search response.
- **Client refactor ordering (tasks 8 before 9).** Extract `renderTile` first,
  then reuse it for search, so the shelf and search share one send path. Ensure
  `renderTile` captures the current `kindleSet` (search hits must be disabled
  when the reader has no Kindle address, same as the shelf).
- **`byToken` timing/format guard.** It rejects tokens shorter than 20 or longer
  than 200 chars and compares constant-time — reuse it as-is on both routes; do
  not add your own token length/format checks that could create a timing oracle.
- **Rate limit / caching already handled** by the `/reader` and `/reader/api`
  middleware (server.js 70-77). Mount the new routes under those paths; do not
  add `no-store`/limiter yourself.
- **Reader `/reader/api/send` already accepts any library book id** (it resolves
  the download entry from `history.readAll()` and re-checks
  `verified`/`isSafeEpubPath`), so search hits >30 days old send fine without any
  send-route change. Confirm you did not accidentally scope send to recent books.
- **Don't stamp `source:'list'` on reader watches** — that would subject them to
  the radar's slower `listFloorMs` cadence in `dueWatchesMixed`. Leave `source`
  unset.

## Out of scope (do not build)

- Live Mobilism/forum search from the reader UI (operator-only, stays that way).
- A persistent "watches I'm waiting on" list/section on the reader shelf; any
  polling or watch-management UI for readers.
- Notifying the operator (in addition to the reader) when a reader-added watch is
  fulfilled — reader-only.
- Any change to the operator dashboard's search/watchlist UI (`public/app.js`) or
  to `watchlist.add()`'s contract.
- New rate limiters or auth mechanisms beyond the existing `/reader` middleware
  and `reader.byToken`.
- New npm dependencies.
- Docker rebuild/redeploy — not part of this change; ship via `npm run docker:up`
  only when the feature is verified and the operator asks.
