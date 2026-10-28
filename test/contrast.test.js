'use strict';

// Colour-contrast guard (critique 2026-10-27). White on the brand orange was
// 3.4:1 (2.5–2.8:1 for dark-mode hovers/chips) — below WCAG AA for 15px/600
// button labels, whatever DESIGN.md said about "large text". The accent now
// has separate roles; this test reads the real token values out of both
// stylesheets (admin style.css and the reader page's inline <style>) and
// checks every text/fill pairing the UI uses, in light and dark.
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const PUB = path.join(__dirname, '..', 'public');
const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
const readerHtml = fs.readFileSync(path.join(PUB, 'reader.html'), 'utf8');

function lum(hex) {
  const c = hex.replace('#', '');
  const full = c.length === 3 ? c.split('').map((x) => x + x).join('') : c;
  const [r, g, b] = full.match(/../g).map((x) => parseInt(x, 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// Collect `--name: #hex` declarations from a block of CSS.
function tokens(block) {
  const out = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,6})\b/g)) out[m[1]] = m[2];
  return out;
}
// Light = the first :root block; dark = the :root inside the first
// prefers-color-scheme: dark block, layered over light.
function themes(src) {
  const light = tokens(src.slice(src.indexOf(':root'), src.indexOf('}', src.indexOf(':root'))));
  const d = src.indexOf('@media (prefers-color-scheme: dark)');
  const darkRoot = src.indexOf(':root', d);
  const dark = { ...light, ...tokens(src.slice(darkRoot, src.indexOf('}', darkRoot))) };
  return { light, dark };
}

const AA = 4.5;
const PAIRS = [
  ['on-accent', 'accent-fill', 'button label on accent fill'],
  ['on-accent', 'accent-fill-hover', 'button label on hovered fill'],
  ['on-accent', 'good', 'label on a green fill (premium download)'],
  ['on-accent', 'danger', 'label on a red fill'],
  ['accent-ink', 'surface', 'orange link text on a card'],
  ['accent-ink', 'bg', 'orange link text on the page'],
  ['good', 'surface', 'green status text'],
  ['warn', 'surface', 'warning text'],
  ['text-dim', 'bg', 'muted text'],
];

for (const theme of ['light', 'dark']) {
  test(`admin style.css (${theme}): every accent/semantic pairing meets AA`, () => {
    const t = themes(css)[theme];
    for (const [fg, bg, what] of PAIRS) {
      assert.ok(t[fg] && t[bg], `tokens --${fg} / --${bg} exist`);
      const r = ratio(t[fg], t[bg]);
      assert.ok(r >= AA, `${what}: --${fg} ${t[fg]} on --${bg} ${t[bg]} is ${r.toFixed(2)}:1`);
    }
  });

  test(`reader.html (${theme}): send buttons, status and error text meet AA`, () => {
    const t = themes(readerHtml)[theme];
    for (const [fg, bg, what] of [
      ['on-accent', 'accent-fill', 'Send button label'],
      ['on-accent', 'accent-fill-hover', 'hovered Send label'],
      ['good', 'surface', '"✓ Sent" outline'],
      ['good', 'bg', '"✓ Sent" in the modal bar'],
      ['err', 'surface', 'send error'],
      ['dim', 'bg', 'muted text'],
    ]) {
      const r = ratio(t[fg], t[bg]);
      assert.ok(r >= AA, `${what}: --${fg} ${t[fg]} on --${bg} ${t[bg]} is ${r.toFixed(2)}:1`);
    }
  });
}

test('reader.html dark palette matches the admin’s (DESIGN.md §9: values match)', () => {
  const a = themes(css).dark;
  const r = themes(readerHtml).dark;
  assert.equal(r.text, a.text);
  assert.equal(r.dim, a['text-dim']);
  assert.equal(r.border, a.border);
  assert.equal(r['accent-fill'], a['accent-fill']);
  assert.equal(r['on-accent'], a['on-accent']);
});

test('no white-on-orange label left: fills use --on-accent', () => {
  assert.ok(!/background: var\(--accent\);\s*color: #fff/.test(css));
  assert.ok(!/background: var\(--accent\); color: #fff/.test(css));
  assert.ok(!/background: var\(--accent\); color: #fff/.test(readerHtml));
});
