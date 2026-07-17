# Implementation Plan: Top-level "Recipients" nav entry

Concept brief: `.claude/plans/recipients-nav-brief.md` (read it too — this plan
assumes its scope). This plan is self-contained; you have only the repo and this
file. Line numbers below were verified against the live files at HEAD `f86e5ca`
but re-grep before editing — treat them as hints, not exact anchors.

---

## Summary

Recipient management (add / delete / invite to reader portal / rotate reader
link) currently lives only inside the Send modal's collapsible "Manage
recipients" panel (`#managePanel`), and the Send modal only opens after a
completed premium download. That leaves no way to add a recipient (e.g. a new
family member) on demand. We add a permanent top-level **Recipients** button to
the topbar (next to Library / Watchlist / History / Status) that opens a new
standalone `#recipientsModal` hosting the recipient list + add form + per-row
Invite/rotate/Delete actions. The recipient-management markup is **moved** out of
the Send modal into this one shared modal; the Send modal's "Manage recipients"
button is rewired to open the same modal (single surface, single data source —
the existing global `recipientsCache`). No backend, data-model, or API changes.

---

## Approach & key decisions

**One shared modal, both triggers open it.** Physically relocate the recipient
add-form (`#recipForm`) and the manage list (`#manageList`) from inside
`#sendModal`'s `#managePanel` into a new standalone `#recipientsModal`. Both the
new topbar `#recipientsToggle` and the existing Send-modal `#manageToggle` call
one `openRecipientsModal()`. Because `renderManageList()` targets `#manageList`
by global ID and `#recipForm`'s submit handler binds by global ID, moving the
markup keeps all existing JS working with only trivial rewiring — no duplicated
render/add logic. This is the brief's explicitly preferred design.

**`recipientsCache` is already the single source of truth.** It's a module-level
global refreshed by `loadRecipients()`. Any surface that calls `loadRecipients()`
re-reads `/api/recipients` and re-renders every list, so AC5 (no stale duplicate
state) is satisfied for free. `loadRecipients()` does **not** reference `sendCtx`
today, so it already works with `sendCtx === null` — decoupling is minimal.

**Groups stay in the Send modal.** `#managePanel` currently also holds the
recipient **Groups** section (`#groupForm`, `#groupManageList`). Group creation
reads the Send modal's selection checkboxes (`#rc_*` in `#recipientList`), so it
is intrinsically a Send-flow feature and must not move to the context-free
Recipients modal. After we remove the recipient half of `#managePanel`, the panel
holds only Groups. Since `#manageToggle` no longer toggles it, we add one small
`#groupsToggle` button ("Groups") in the Send modal's action row to reveal the
groups panel. This is the minimum change needed to avoid regressing group
management; it touches nothing about recipient *selection*.

**Rejected alternatives:**
- *Two separate recipient lists (one in each modal) sharing a multi-target render
  function.* The brief permits this as a fallback but explicitly prefers one
  shared modal, and it would leave `#manageToggle` opening an inline panel rather
  than "the same shared surface." It also duplicates the add-form markup.
  Rejected.
- *Move the Groups section into the new modal too.* Group creation depends on the
  Send modal's selection checkboxes, which don't exist in the context-free modal;
  this would break group creation or require redesigning group membership
  selection — out of scope. Rejected.
- *Fold Recipients into Settings.* The brief records the user's explicit choice
  for a top-level nav button. Rejected.

---

## Step-by-step tasks

Do them in this order. Each is independently verifiable.

### 1. Add the topbar button — `public/index.html`

In `.topbar-actions` (currently ~lines 43-49), add a new button. Place it after
`#statusToggle` and before `#settingsToggle` (the ⚙ gear):

```html
<button id="recipientsToggle" class="ghost-btn" type="button" title="Manage recipients &amp; reader invites">👥 Recipients</button>
```

Match the existing `ghost-btn` pattern. The 👥 emoji-prefixed label matches the
🔔 Watchlist convention; plain "Recipients" is also acceptable per the brief.
Verify: the button renders in the navbar. It does nothing yet.

### 2. Create the standalone modal — `public/index.html`

Add a new modal. Put it immediately **after** the `#statusModal` block (ends
~line 388, before `<script src="app.js">`), mirroring the `#statusModal`
structure (✕ close button + Escape, no backdrop-click close):

```html
<!-- Recipients management modal (top-level; no download/send context needed) -->
<div id="recipientsModal" class="modal" role="dialog" aria-modal="true" aria-label="Recipients" hidden>
  <div class="modal-card recipients-card">
    <button id="recipientsClose" class="dl-close" type="button" aria-label="Close">✕</button>
    <h2>Recipients</h2>
    <p class="hint">Add readers, invite them to their personal shelf, or remove them. No download needed.</p>
    <!-- #recipForm and #manageList are MOVED here from #managePanel in step 3 -->
  </div>
</div>
```

Leave a placeholder comment where `#recipForm` + `#manageList` will land; step 3
moves the exact existing markup here.

### 3. Move recipient markup out of the Send modal — `public/index.html`

In `#sendModal` → `#managePanel` (currently ~lines 270-289), the panel contains
two halves:

- Recipients: `<h3>Recipients</h3>`, `<form id="recipForm" class="recip-form">…</form>`,
  `<div id="manageList" class="manage-list"></div>`
- Groups: `<h3>Groups</h3>`, `<p class="hint">…</p>`, `<form id="groupForm" …>…</form>`,
  `<div id="groupManageList" class="manage-list"></div>`

**Cut** the Recipients half — the `<h3>Recipients</h3>` line, the entire
`#recipForm` (lines ~272-279, all five inputs `#rName #rEmail #rKindle #rPhone
#rCarrier` + the Add submit button), and `<div id="manageList">` — and **paste it
verbatim** into `#recipientsModal` at the placeholder from step 2. Do not rename
any IDs or classes. You may drop the now-redundant `<h3>Recipients</h3>` since the
new modal already has an `<h2>Recipients</h2>` heading.

`#managePanel` now holds only the Groups half. Keep `#managePanel hidden` and its
Groups content unchanged.

Verify: `#recipForm` and `#manageList` now live inside `#recipientsModal`;
`#managePanel` contains only groups markup; no duplicate IDs anywhere
(`grep -c 'id="recipForm"' public/index.html` → 1, same for `manageList`).

### 4. Add a Groups toggle in the Send modal — `public/index.html`

In `#sendModal`'s `.modal-actions` row (~lines 263-268), the current
`#manageToggle` button ("Manage recipients") stays but will be rewired in JS to
open the new modal. Add a second button for the groups panel, right after it:

```html
<button type="button" id="manageToggle" class="ghost-btn">Manage recipients</button>
<button type="button" id="groupsToggle" class="ghost-btn">Groups</button>
```

Verify: both buttons render in the Send modal action row.

### 5. Rewire recipient JS — `public/app.js`

All in the "Send / notify" section (~lines 1363-1509).

a. **`renderManageList()` empty state (nice-to-have, low risk).** Currently
(~line 1413) it renders nothing when `recipientsCache` is empty, which looks blank
in the standalone modal. After clearing `ml.innerHTML`, add:

```js
if (!recipientsCache.length) {
  ml.append(el('p', { className: 'hint' }, 'No recipients yet — add one above.'));
  return;
}
```

`renderManageList()` still targets `$('#manageList')`, which now resolves to the
new modal — no other change needed there.

b. **Rewire `#manageToggle`.** Replace its current handler (~lines 1486-1489,
which toggles `#managePanel`) so it opens the shared modal:

```js
$('#manageToggle').addEventListener('click', openRecipientsModal);
```

c. **Add the `#groupsToggle` handler** (near the old manageToggle handler) to
toggle the now-groups-only panel:

```js
$('#groupsToggle').addEventListener('click', () => {
  const p = $('#managePanel');
  p.hidden = !p.hidden;
});
```

d. **Add open/close for the new modal.** Add near the other Send/notify code
(e.g. just after `closeSendModal`, ~line 1379), following the `openStatus` /
`closeStatus` pattern (app.js ~1905-1911):

```js
const recipientsModal = $('#recipientsModal');
async function openRecipientsModal() {
  await loadRecipients();     // refreshes recipientsCache + re-renders #manageList
  recipientsModal.hidden = false;
}
function closeRecipientsModal() { recipientsModal.hidden = true; }
$('#recipientsToggle').addEventListener('click', openRecipientsModal);
$('#recipientsClose').addEventListener('click', closeRecipientsModal);
```

Note: `loadRecipients()` also repaints `#recipientList` (the Send selection list).
That container lives in the hidden Send modal when opened from the topbar —
harmless (writes into a hidden node, no error). Do not gate on `sendCtx`.

e. **`openSendModal` unchanged except confirm it still collapses groups.** It sets
`$('#managePanel').hidden = true;` (~line 1373) — keep it; the panel is now
groups-only and should start collapsed. It still calls `loadRecipients()` and
`loadGroups()` — keep both.

Verify: from the topbar button, the modal opens and lists recipients; the Send
modal's "Manage recipients" opens the same modal; "Groups" toggles the groups
panel.

### 6. Wire focus-trap and Escape — `public/app.js`

a. **`FOCUS_SURFACES`** (~line 3417). Add `'#recipientsModal'` before
`'#sendModal'` (it can stack on top of the Send modal when opened via
`#manageToggle`, so it must have higher dismissal priority):

```js
const FOCUS_SURFACES = ['#settingsModal', '#statusModal', '#recipientsModal', '#sendModal', '#credModal', '#batchModal', '#downloadModal', '#libraryPanel', '#historyPanel'];
```

The Tab-trap, the opener-focus `MutationObserver`, and its observe loop all
iterate `FOCUS_SURFACES` automatically — adding the ID wires all three. No other
change needed there.

b. **Escape chain** (~lines 3480-3492). Add a branch for the new modal, placed
**before** the `sendModal` branch (matches stacking order):

```js
if (!$('#statusModal').hidden) return closeStatus();
if (!recipientsModal.hidden) return closeRecipientsModal();   // <-- add
if (!sendModal.hidden) return closeSendModal();
```

`recipientsModal` is in scope from step 5d (module-level const). Verify: Escape
closes the recipients modal; when it's stacked over the Send modal, Escape closes
the recipients modal first, leaving the Send modal open.

### 7. CSS — `public/style.css`

Add one rule so the ✕ (`.dl-close`, which is `position: absolute`) anchors to the
card and the card is comfortably wide — mirroring `.status-card` (~line 1189):

```css
.recipients-card { width: min(460px, 94vw); position: relative; }
```

Everything else reuses existing classes: `.modal`, `.modal-card`, `.recip-form`,
`.manage-list`, `.manage-row`, `.manage-actions`, `.dl-close`, `.ghost-btn`,
`.hint`. The topbar button needs no new CSS — `.ghost-btn` + existing
`.topbar-actions` flex/wrap and the `max-width: 520px` / `400px` responsive rules
(~lines 1056-1067) already cover the extra button. Verify: modal is centered and
scrollable, ✕ sits top-right of the card, add-form is the usual two-column grid.

---

## Data / model / API changes

**None.** Confirmed against `src/server.js`: the endpoints already exist and are
untouched —
`GET/POST /api/recipients` (789, 793), `DELETE /api/recipients/:id` (802),
`POST /api/recipients/:id/invite` (811), `POST /api/recipients/:id/reader-token`
(821), plus `/api/recipient-groups` (835, 839, 848). No schema, `recipients.json`,
or route changes. This is a pure client-side markup/JS relocation + one CSS rule.

---

## Testing & verification

No automated frontend suite exists; verify manually. Run the app:

```bash
npm run dev      # node --watch src/server.js; public/* served static
```

Open the app (through the normal CF-Access-gated URL, or hit the origin directly
if running locally). Hard-refresh to bust the static `app.js`/`style.css` cache.

Map each acceptance criterion to a check:

1. **Button always present** — With no download performed, confirm a "👥
   Recipients" button sits in the navbar beside Library/Watchlist/History/Status.
2. **Opens with the list** — Click it; the modal shows each recipient's
   `name · email · kindleEmail` plus the reader-status hint and Invite / ♻ /
   Delete controls (identical to the old `#manageList`).
3. **Add without a download** — In the modal's form, add a recipient
   (name/email/kindleEmail/phone/carrier) and Submit; it appears immediately in
   the list. Never touched the Send flow.
4. **Delete / Invite / Rotate** — Delete a throwaway recipient; Invite one
   (reader-portal magic link email) — button shows "Sending…" → "✓ Invited";
   Rotate (♻) after confirm. All behave as before. (Invite needs SMTP configured;
   if not, the button surfaces the error, which is the pre-existing behavior — not
   a regression.)
5. **Shared data with Send modal** — Complete a premium download to open the Send
   modal (or trigger it from a Library row's send action), click "Manage
   recipients": it opens the *same* modal showing the recipient just added.
   Add/delete in one place, reopen the other — data matches (single
   `recipientsCache`).
6. **Escape / focus trap** — Tab cycles within the modal only; opening focuses the
   first control; closing returns focus to the trigger; Escape closes it; when
   opened from the Send modal's "Manage recipients", Escape closes the recipients
   modal first and leaves the Send modal open.
7. **No Send-flow regression** — In the Send modal: recipient **selection**
   checkboxes still list recipients; the "Groups" button reveals the groups panel;
   creating a group from checked recipients and deleting a group still work;
   selecting recipients and Send still works and renders results.

Optional: the `webapp-testing` (Playwright) skill can drive steps 1-6.

Sanity checks before manual run:
```bash
grep -c 'id="recipForm"'  public/index.html   # expect 1
grep -c 'id="manageList"' public/index.html   # expect 1
grep -n  'recipientsModal' public/index.html public/app.js public/style.css
node -e "require('fs').readFileSync('public/app.js','utf8')"  # smoke: file parses as text
```
(There's no JS lint/build step; a browser hard-refresh with the devtools console
open is the real check for runtime errors.)

---

## Risks & watch-outs

- **Duplicate IDs.** The whole approach depends on `#recipForm` and `#manageList`
  existing exactly once. After the move, grep to confirm you *cut* (not copied)
  them from `#managePanel`. A duplicate ID means `$()` grabs the wrong node and
  renders silently break.
- **Escape / FOCUS_SURFACES ordering.** `#recipientsModal` must come *before*
  `#sendModal` in both `FOCUS_SURFACES` and the Escape chain, because it can stack
  on top of the Send modal. Wrong order → Escape closes the Send modal out from
  under it, or Tab traps in the wrong surface.
- **Don't gate the modal on `sendCtx`.** `openRecipientsModal()` must never
  require a book/download. `loadRecipients()` already avoids `sendCtx`; keep it
  that way. Only `#sendGo` and group creation use `sendCtx`/`#rc_*` checkboxes.
- **Groups coupling.** Do not move the Groups section; it reads the Send modal's
  `#rc_*` selection checkboxes. After removing the recipient half of
  `#managePanel`, make sure the `#groupsToggle` button actually reveals the panel
  (test it) — otherwise group management becomes unreachable (a regression).
- **`openSendModal` still collapses `#managePanel`.** Leave the
  `$('#managePanel').hidden = true;` line; the panel is now groups-only and should
  open collapsed.
- **Static caching.** `public/*` is served as-is with no cache-busting; hard-
  refresh (or verify `Cache-Control`) when testing, or you'll debug stale JS.
- **`renderManageList()` target.** It still queries `$('#manageList')` — correct
  after the move, since there's exactly one such node (now in the new modal). Don't
  scope it to `sendModal`.

---

## Out of scope (do not build)

- No changes to the recipient data model, `/api/recipients*` or
  `/api/recipient-groups*` endpoints, or `recipients.json` schema.
- No changes to the Send flow's recipient **selection** checkboxes
  (`#recipientList` / `#rc_*`) — selection stays in the Send modal.
- No new auth/permissions surface — the existing origin-side CF Access gate
  already protects the whole app.
- No mobile redesign beyond the existing `.topbar-actions` responsive rules;
  don't invent new breakpoints.
- No new visual system — reuse existing `.modal`/`.ghost-btn`/`.manage-row` CSS;
  the only new rule is `.recipients-card`.
- Don't rework the Groups feature (its selection model, chips, or creation flow);
  just keep it reachable via the new `#groupsToggle`.

**Deploy note (not part of the code change):** this repo ships via
`npm run docker:up` (stamps version/commit/build-time), not plain
`docker compose`. Bumping `package.json` `version` (currently `1.21.0`) and
committing is the project's release convention, but leave the actual deploy/commit
to the human unless asked.
