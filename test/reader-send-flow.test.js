'use strict';

// Reader first-visit onboarding + send flow (critique 2026-10-27): books come
// before onboarding (one tip per visit, install hint only on a return visit),
// "sent" never claims the book is ON the Kindle, re-send lives in the modal,
// and the modal's send action stays reachable on phones. The page script is a
// browser file, so its pure helpers are exercised by loading it into a vm
// with just enough DOM stubbed for the no-token early return.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'reader.html'), 'utf8');
const js = fs.readFileSync(path.join(PUBLIC, 'reader.js'), 'utf8');

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    dump: () => Object.fromEntries(m),
  };
}

// Loads reader.js with no ?t= so the IIFE bails out immediately, leaving the
// top-level helpers defined on the context.
function load({ storage = fakeStorage() } = {}) {
  const stubNode = () => ({ textContent: '' });
  const ctx = {
    location: { search: '' },
    localStorage: storage,
    document: { querySelector: stubNode, getElementById: () => null, createElement: () => ({}) },
    URLSearchParams,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(js, ctx);
  return ctx;
}

// Minimal element factory standing in for reader.js's el() helper.
function fakeEl() {
  const made = [];
  const el = (tag, attrs = {}, kids = []) => {
    const n = { tag, ...attrs, kids: [].concat(kids), removed: false, remove() { this.removed = true; } };
    made.push(n);
    return n;
  };
  return { el, made };
}
function fakeTarget() {
  const classes = new Set();
  const inserted = [];
  return {
    classes,
    inserted,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    insertAdjacentElement: (where, n) => inserted.push({ where, n }),
  };
}

// --- sendErrorMessage -----------------------------------------------------------

test('sendErrorMessage: passes the server’s reader-facing messages through', () => {
  const { sendErrorMessage } = load();
  assert.equal(sendErrorMessage(429, 'That’s a lot of books at once!'), 'That’s a lot of books at once!');
  assert.equal(sendErrorMessage(409, 'No Kindle address is saved'), 'No Kindle address is saved');
  assert.equal(sendErrorMessage(410, 'That book is no longer available.'), 'That book is no longer available.');
});

test('sendErrorMessage: 5xx / network never leak raw server errors', () => {
  const { sendErrorMessage } = load();
  const calm = 'Couldn’t send it right now. Please try again in a minute.';
  assert.equal(sendErrorMessage(500, 'SMTP is not configured'), calm);
  assert.equal(sendErrorMessage(502), calm);
  assert.equal(sendErrorMessage(0), calm);
  assert.equal(sendErrorMessage(429), calm, 'no server message → still calm');
});

// --- countVisit --------------------------------------------------------------------

test('countVisit: counts up per load and survives blocked storage', () => {
  const storage = fakeStorage();
  const ctx = load({ storage });
  assert.equal(ctx.countVisit(), 1);
  assert.equal(ctx.countVisit(), 2);
  assert.equal(storage.dump().bh_visits, '2');
  ctx.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(ctx.countVisit(), 1);
});

// --- spotlightFeature: one tip per visit --------------------------------------------

test('spotlightFeature: only the first unseen tip shows per page load', () => {
  const storage = fakeStorage();
  const ctx = load({ storage });
  const { el } = fakeEl();
  const a = fakeTarget();
  const b = fakeTarget();
  ctx.spotlightFeature({ id: 'first', target: a, title: 'A', body: 'a', el });
  ctx.spotlightFeature({ id: 'second', target: b, title: 'B', body: 'b', el });
  assert.ok(a.classes.has('spotlight-ring'), 'first tip shows');
  assert.equal(b.classes.size, 0, 'second tip waits');
  assert.equal(b.inserted.length, 0);
  assert.equal(storage.dump().bh_spotlight_second, undefined, 'the waiting tip is NOT marked seen');
  assert.equal(ctx.spotlightShownThisVisit, true);
});

test('spotlightFeature: an already-seen tip does not use up the visit’s slot', () => {
  const ctx = load({ storage: fakeStorage({ bh_spotlight_first: '1' }) });
  const { el } = fakeEl();
  const a = fakeTarget();
  const b = fakeTarget();
  ctx.spotlightFeature({ id: 'first', target: a, title: 'A', body: 'a', el });
  ctx.spotlightFeature({ id: 'second', target: b, title: 'B', body: 'b', el });
  assert.equal(a.classes.size, 0);
  assert.ok(b.classes.has('spotlight-ring'), 'next unseen tip gets this visit');
});

test('spotlightFeature: bubbleAt places the callout (e.g. after the first row)', () => {
  const ctx = load();
  const { el } = fakeEl();
  const target = fakeTarget();
  const rowEnd = fakeTarget();
  const dismiss = ctx.spotlightFeature({ id: 'x', target, title: 'T', body: 'b', el, bubbleAt: { el: rowEnd, where: 'afterend' } });
  assert.equal(rowEnd.inserted.length, 1);
  assert.equal(rowEnd.inserted[0].where, 'afterend');
  assert.equal(target.inserted.length, 0);
  dismiss();
  assert.equal(target.classes.size, 0, 'dismiss clears the ring');
});

// --- page wiring (static) ------------------------------------------------------------

test('reader.js: book-details tip is announced before search, and anchored after the first row', () => {
  assert.ok(js.indexOf('details.announce(grid)') < js.indexOf('setupSearch(t, $, el, renderTile)'), 'priority: tap-a-book first');
  assert.ok(js.includes("bubbleAt: { el: endOfRow, where: 'afterend' }"));
  assert.ok(html.includes('.grid > .spotlight-bubble { grid-column: 1 / -1;'), 'callout spans the grid row');
});

test('reader.js: install hint waits for a return visit with no tip showing', () => {
  assert.ok(js.includes('if (visits >= 2 && !spotlightShownThisVisit) installHint.allow();'));
});

test('reader.js: sent copy never claims the book is ON the Kindle', () => {
  assert.ok(!js.includes('On your Kindle'), 'old overclaiming label is gone');
  assert.ok(!js.includes('On its way'), 'old overclaiming label is gone');
  assert.ok(js.includes("'✓ Sent to your Kindle'"));
  assert.ok(js.includes('approved senders'), 'post-send help names the usual failure');
  assert.ok(!html.includes('arrives in your Kindle library'), 'footer no longer promises delivery');
});

test('reader.js: re-send lives in the modal; a sent tile just opens details', () => {
  assert.ok(js.includes("btn.textContent = 'Send again'"));
  assert.ok(js.includes("if (b.sent && where === 'tile') return;"), 'sent tile click bubbles to the tile');
  assert.ok(js.includes("wireSend($('#bookSend'), err, b, kindleSet, onSent, 'modal')"));
});

test('reader.html: modal send action has a status line and sticks on phones', () => {
  assert.match(html, /<div class="actions">\s*<p id="bookStatus" class="status" role="status" hidden><\/p>\s*<button id="bookSend"/);
  assert.match(html, /@media \(max-width: 759px\) \{\s*\.book \.actions \{ position: sticky; bottom: 0;/);
});

test('reader.html: a11y fixes — labelled search, single clear button, calm pulse, theme-aware errors', () => {
  assert.match(html, /id="searchInput"[^>]*aria-label="Search all books"/);
  assert.ok(html.includes('::-webkit-search-cancel-button'), 'native ✕ hidden so only one clear button shows');
  assert.match(html, /prefers-reduced-motion: reduce\) \{[^}]*\.spotlight-ring/);
  assert.ok(html.includes('.err { color: var(--err);'));
  assert.ok(!/\.err \{ color: #c0392b/.test(html));
});
