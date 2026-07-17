# Brief: Top-level "Recipients" nav entry

## Problem
Recipient management ("Manage recipients" — add/delete a recipient, invite them to the
reader portal, rotate their reader link) only exists nested inside the **Send** modal
(`#sendModal` → `#manageToggle` → `#managePanel`, `public/index.html:251-330ish`,
`public/app.js` `openSendModal`/`loadRecipients`/`renderManageList`). The Send modal itself
only opens after a **premium download** completes and passes ePUB verification (see
[[notifications-send-to-kindle]] memory). So to add a new recipient (e.g. an invite for a new
family member), Eric currently has no direct path — he has to either remember there's a
button buried in a modal he can only reach via a completed download, or hunt through the UI.
This was reported as a real pain point after trying to add someone one evening.

## Goal
Make recipient management reachable directly from the app's top-level navigation
(`.topbar-actions` in `public/index.html:43-49`, alongside Library / Watchlist / History /
Status), independent of any download or Send flow. Adding, deleting, inviting to reader
portal, and rotating reader links should all be usable from this new entry point at any time.

## In scope
- A new top-level nav button (e.g. `#recipientsToggle`, label "Recipients" or "👥 Recipients")
  in `.topbar-actions`, following the exact same pattern as `#libraryToggle` /
  `#historyToggle` / `#statusToggle` (ghost-btn, opens a modal/panel, wired via
  `addEventListener('click', openX)`).
- A standalone modal/panel (e.g. `#recipientsModal`) that hosts the recipient list +
  add-recipient form + per-recipient actions (Invite / ♻ rotate / Delete), reusing the
  existing markup/logic currently inside `#managePanel` (`recipForm`, `manageList`,
  `renderManageList()`) rather than duplicating it. This should NOT require a `sendCtx`
  (no book/download context) to open or function — it's pure recipient CRUD against
  `/api/recipients*`, which already has no dependency on a download.
- The existing **Send modal's "Manage recipients" toggle stays as a shortcut** — clicking it
  should open the same shared recipient-management surface (not a duplicate/forked one), per
  the user's explicit choice to keep it additive, not remove it.
- Wire the new modal into the existing focus-trap / Escape-to-close plumbing
  (`FOCUS_SURFACES` array in `public/app.js:3417`, and the Escape-key handler chain around
  `public/app.js:3485`) the same way other modals are (`statusModal`, `sendModal`, etc.).
- Follow existing CSS conventions in `public/style.css` for `.modal`, `.modal-card`,
  `.ghost-btn`, `.manage-row`, `.recip-form`, etc. — no new visual system needed.

## Out of scope
- No changes to the recipient data model, `/api/recipients*` endpoints, or `recipients.json`
  schema.
- No changes to the Send flow's recipient **selection** checkboxes (`#recipientList` inside
  `#sendModal`, used to pick who to send *this* book to) — that remains inside the Send modal
  as-is; only the *management* (add/delete/invite/rotate) surface is being promoted.
- No new permissions/auth model — this is client-side UI reachable the same way other
  top-level buttons are (no separate auth surface; existing origin-side CF Access gate still
  protects the whole app per [[security-hardening]]).
- No mobile-specific redesign beyond matching how other topbar buttons already behave
  responsively (check `public/style.css` for any existing `.topbar-actions` responsive rules
  and follow them, don't invent new ones).

## Constraints
- Plain HTML/CSS/vanilla JS app (no framework) — `public/index.html`, `public/app.js`,
  `public/style.css`. No bundler/build step for frontend; files are served as-is.
- Must not break the Send modal's existing "Manage recipients" shortcut behavior or its
  recipient-selection checkboxes.
- Must not duplicate the `loadRecipients()` / `renderManageList()` logic — refactor so both
  entry points (top-level nav and Send-modal shortcut) call the same functions against the
  same DOM containers, OR render into two containers driven by one shared render function.
  Prefer: one shared modal, both triggers open it.
- `recipientsCache` and `loadRecipients()` currently live in the "Send / notify" section of
  `app.js` (~line 1360+) and are coupled to `sendCtx`/`openSendModal`. These need to be
  decoupled so recipient management works with `sendCtx === null`.

## Acceptance criteria
1. A new "Recipients" (or similar label) button appears in the top navbar next to
   Library/Watchlist/History/Status, at all times — not conditional on any download.
2. Clicking it opens a modal that immediately shows the current recipient list with
   name/email/kindleEmail, and per-recipient Invite/♻/Delete controls — matching what
   currently renders in `#manageList`.
3. From that modal, adding a new recipient via the form (name/email/kindleEmail/phone/carrier)
   works and the new recipient appears immediately, without ever having downloaded a book.
4. Deleting a recipient, inviting them (reader portal), and rotating their reader token all
   still work identically to today, from this new modal.
5. The Send modal's "Manage recipients" button still works and shows the same live data
   (if you add a recipient via the new top-level modal, it shows up in the Send modal's
   management view too, and vice versa — single source of truth, no stale duplicate state).
6. Escape key / focus trap behavior for the new modal matches other modals in the app
   (e.g. `statusModal`).
7. No regressions to the Send flow itself (selecting recipients to send a book to, sending,
   viewing send results).

## Open questions & decisions made
- **Placement:** top-level nav button (not folded into Settings) — user's explicit choice.
- **Plan review:** user opted to skip the plan-approval gate; proceed straight to build once
  the plan is written, but a sanity-check by the orchestrating session still applies before
  build starts.
- **Send modal's embedded toggle:** kept as a shortcut into the same shared surface, not
  removed — user's explicit choice.
- Exact label/icon for the new nav button is not specified — planner/executor may pick
  something consistent with existing buttons' style (e.g. "👥 Recipients" to match the
  🔔 Watchlist emoji-prefixed pattern, or plain "Recipients" to match Library/History's
  plain-text pattern). Not a blocking decision.

## Relevant files/areas
- `public/index.html`:
  - `:18-50` — `<header class="topbar">` / `.topbar-actions` — where the new nav button goes.
  - `:251-` — `#sendModal`, including `#manageToggle` (line 264) and `#managePanel` (line 270+)
    with `#recipForm` and (further down, not yet read in full) `#manageList`.
  - `:378` — `#statusModal` as a reference pattern for a simple top-level modal.
- `public/app.js`:
  - `:1363-1509` — "Send / notify" section: `sendModal`, `openSendModal`, `loadRecipients()`,
    `renderManageList()`, `#manageToggle` click handler, `#recipForm` submit handler. This is
    the logic to decouple/reuse.
  - `:1905-1911` — `statusModal` open/close pattern (`openStatus`/`closeStatus`) — reference
    for wiring a new top-level modal.
  - `:3417` — `FOCUS_SURFACES` array — new modal ID must be added here.
  - `:3485` — Escape-key handler chain — new modal needs a close-on-Escape branch.
- `public/style.css` — existing `.modal`, `.modal-card`, `.manage-row`, `.recip-form`,
  `.topbar-actions` rules to reuse; check for responsive rules on `.topbar-actions`.
- Backend: `/api/recipients` (GET/POST), `/api/recipients/:id` (DELETE),
  `/api/recipients/:id/invite` (POST), `/api/recipients/:id/reader-token` (POST) — already
  exist and need **no changes**.

## Repo commands & tree state
- Run: `npm run dev` (or `npm start`) — `node --watch src/server.js` / `node src/server.js`.
  No frontend build step; `public/*` served as static files directly.
- No automated frontend test suite exists in this repo — verification is manual: exercise the
  UI (open the new modal from the navbar with no prior download, add/delete/invite/rotate a
  recipient, then open the Send modal's shortcut and confirm same data appears).
- `webapp-testing` skill (Playwright) is available in this environment for driving the UI if
  needed for verification.
- Deploy/rebuild for this project uses `npm run docker:up` (NOT plain `docker compose`) —
  see [[rebuild-command]] memory; this stamps version/commit/build-time.
- Git tree state at brief time: clean (`git status` reported nothing to commit on `main`,
  HEAD at `f86e5ca`). No pre-existing uncommitted work to account for.
