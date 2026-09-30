'use strict';
// Regression guard for the BookHunt mark (Ribbon): one canonical shape shared
// by favicon, app icon, topbar and showcase. Catches a stale copy or a revert
// to the old book + magnifying-glass art.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pub = (f) => path.join(__dirname, '..', 'public', f);
const read = (f) => fs.readFileSync(pub(f), 'utf8');
const RIBBON = 'M136 28H176V236L156 216L136 236Z';

test('favicon and app icon use the ribbon mark with brand colours', () => {
  for (const f of ['favicon.svg', 'reader-icon.svg']) {
    const s = read(f);
    assert.ok(s.includes(RIBBON), `${f} missing ribbon path`);
    assert.ok(s.includes('#f1592a') && s.includes('#1c2a56'), `${f} brand colours`);
    assert.ok(!s.includes('<circle'), `${f} still has the old magnifier lens`);
  }
});

test('reader-icon.svg is full-bleed (no rounded corners) so OS masks crop cleanly', () => {
  assert.ok(!/<rect[^>]*\brx=/.test(read('reader-icon.svg')));
  assert.ok(/<rect[^>]*\brx=/.test(read('favicon.svg')));
});

test('inline marks in index.html and the showcase use the ribbon, themed via currentColor', () => {
  for (const f of ['index.html', 'design-showcase.html']) {
    const s = read(f);
    const n = s.split(RIBBON).length - 1;
    assert.strictEqual(n, 2, `${f}: expected 2 inline marks, got ${n}`);
    assert.ok(!s.includes('M9 41 L9 44.5'), `${f} still has the old open-book path`);
  }
});

test('PNG app icons are real PNGs at the declared sizes', () => {
  for (const size of [180, 192, 512]) {
    const b = fs.readFileSync(pub(`reader-icon-${size}.png`));
    assert.strictEqual(b.subarray(1, 4).toString(), 'PNG');
    assert.strictEqual(b.readUInt32BE(16), size);
    assert.strictEqual(b.readUInt32BE(20), size);
  }
});

test('service worker cache version was bumped past v3 so the old logo is evicted', () => {
  const m = /bookhunt-shell-v(\d+)/.exec(read('sw.js'));
  assert.ok(m && Number(m[1]) >= 4);
});
