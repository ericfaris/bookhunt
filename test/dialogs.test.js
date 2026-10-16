'use strict';

// Native browser popups ("bookhunt.mooseflip.com says …") ignore the design
// system. Every question the admin/reader UI asks goes through the in-app
// askDialog (#dialogModal) instead — these pin that so a stray confirm()
// can't creep back in.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const html = read('index.html');
const js = read('app.js');
const css = read('style.css');

// Strip comments so prose mentioning confirm()/alert() doesn't count.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('no native alert/confirm/prompt in any client script', () => {
  for (const f of fs.readdirSync(PUB).filter((n) => n.endsWith('.js'))) {
    const src = code(read(f));
    assert.doesNotMatch(src, /(^|[^.\w])(window\.)?(alert|confirm|prompt)\s*\(/m, `${f} uses a native popup`);
  }
  for (const f of fs.readdirSync(PUB).filter((n) => n.endsWith('.html'))) {
    assert.doesNotMatch(read(f).replace(/<!--[\s\S]*?-->/g, ''), /\b(window\.)?(alert|confirm|prompt)\s*\(/, `${f} uses a native popup`);
  }
});

test('dialog markup is a labelled modal built from design-system parts', () => {
  assert.match(html, /<div id="dialogModal" class="modal ask-modal" role="alertdialog" aria-modal="true" aria-labelledby="dialogTitle"[^>]* hidden>/);
  for (const id of ['dialogTitle', 'dialogMessage', 'dialogForm', 'dialogField', 'dialogInput', 'dialogCancel', 'dialogOk']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} present`);
  }
  assert.match(html, /id="dialogCancel" class="ghost-btn"/);
  assert.match(html, /id="dialogOk" class="primary-btn"/);
});

test('dialog sits above the mega view and lightbox, with a danger variant', () => {
  const z = (sel) => Number((css.match(new RegExp(sel.replace('.', '\\.') + '\\s*\\{[^}]*z-index:\\s*(\\d+)')) || [])[1]);
  assert.ok(z('.ask-modal') > z('.mega'), 'above mega');
  assert.ok(z('.ask-modal') > z('.lightbox'), 'above lightbox');
  assert.match(css, /\.primary-btn\.danger-btn\s*\{[^}]*var\(--danger\)/);
});

test('dialog is wired into focus trap and Escape, top-most first', () => {
  assert.match(js, /const FOCUS_SURFACES = \['#dialogModal',/);
  const esc = js.slice(js.indexOf("if (e.key !== 'Escape') return;"));
  assert.ok(esc.indexOf('cancelDialog()') < esc.indexOf('closeNav()'), 'Escape cancels the dialog before anything else');
});

test('destructive actions confirm via the danger dialog', () => {
  const dangerCalls = js.match(/confirmDialog\(\{[\s\S]*?danger: true,[\s\S]*?\}\)/g) || [];
  assert.ok(dangerCalls.length >= 5, `expected ≥5 danger confirms, got ${dangerCalls.length}`);
  assert.match(js, /async function editBookTags[\s\S]*?await promptDialog\(/);
  assert.match(js, /if \(input === null\) return;/, 'cancelled tag prompt is a no-op');
});

// Every call that destroys or withdraws something must sit behind a confirm.
// Each entry: the request that does the damage, and the confirm that must
// come before it within the same handler.
test('every destructive request is preceded by a confirmation', () => {
  const guarded = [
    ["fetch('/api/recipients/' + r.id + '/reader-token'", 'confirmDialog'],
    ["fetch('/api/recipients/' + r.id, { method: 'DELETE' })", 'confirmDialog'],
    ["fetch('/api/recipient-groups/' + g.id, { method: 'DELETE' })", 'confirmDialog'],
    ["fetch('/api/library/' + id, { method: 'DELETE' })", 'confirmDialog'],
    ["fetch('/api/library/' + book.id, { method: 'DELETE' })", 'confirmDialog'],
    ['fetch(`/api/watchlist/${w.id}`, { method: \'DELETE\' })', 'confirmDialog'],
    ["fetch('/api/reupload/cancel'", 'confirmDialog'],
  ];
  for (const [call, guard] of guarded) {
    const at = js.indexOf(call);
    assert.ok(at > 0, `found ${call}`);
    const before = js.slice(Math.max(0, at - 700), at);
    assert.ok(before.includes(`await ${guard}(`), `${call} is confirmed first`);
  }
  // Nothing new deletes without being added above.
  const deletes = js.match(/method: 'DELETE'/g) || [];
  assert.equal(deletes.length, 5, 'a new DELETE call needs a confirm + an entry here');
});

test('reader: stopping emails always asks first, never on load', () => {
  const rjs = read('reader.js');
  const click = rjs.slice(rjs.indexOf("$('#unsub').onclick"));
  assert.match(click.slice(0, 200), /askStopEmails\(/, 'footer link asks instead of unsubscribing');
  assert.ok(!/\$\('#unsub'\)\.onclick[^}]*\/reader\/api\/unsubscribe/.test(rjs), 'footer link does not POST directly');
  assert.match(rjs, /yes\.onclick = \(\) => \{ bar\.remove\(\); stopEmails\(\); \}/);
  assert.match(rjs, /if \(qs\.get\('unsub'\) === '1'\) askStopEmails\(/);
});
