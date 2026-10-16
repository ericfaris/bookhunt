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
