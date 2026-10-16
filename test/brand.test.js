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

test('icon master (scripts/icons/icon.svg) is the ribbon mark in brand colours', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'icons', 'icon.svg'), 'utf8');
  assert.ok(s.includes(RIBBON), 'master missing ribbon path');
  assert.ok(s.includes('id="bg"') && s.includes('id="mark"'), 'master has bg + mark layers');
  assert.ok(!s.includes('<circle'), 'master still has the old magnifier lens');
});

test('inline marks in index.html and the showcase use the ribbon, themed via currentColor', () => {
  for (const f of ['index.html', 'design-showcase.html']) {
    const s = read(f);
    const n = s.split(RIBBON).length - 1;
    assert.strictEqual(n, 2, `${f}: expected 2 inline marks, got ${n}`);
    assert.ok(!s.includes('M9 41 L9 44.5'), `${f} still has the old open-book path`);
  }
});

// The house icon set (same as redline/jambo): favicon.ico + apple-touch + 192/512 + maskable.
const ICONS = { 'apple-touch-icon.png': 180, 'icon-192.png': 192, 'icon-512.png': 512, 'icon-maskable-512.png': 512 };

test('PNG app icons are real PNGs at the declared sizes', () => {
  for (const [f, size] of Object.entries(ICONS)) {
    const b = fs.readFileSync(pub(f));
    assert.strictEqual(b.subarray(1, 4).toString(), 'PNG', f);
    assert.strictEqual(b.readUInt32BE(16), size, `${f} width`);
    assert.strictEqual(b.readUInt32BE(20), size, `${f} height`);
  }
  const ico = fs.readFileSync(pub('favicon.ico'));
  assert.deepStrictEqual([...ico.subarray(0, 6)], [0, 0, 1, 0, 3, 0], 'favicon.ico holds 3 images');
  assert.deepStrictEqual([ico[6], ico[22], ico[38]], [16, 32, 48], 'favicon.ico sizes 16/32/48');
});

test('pages and manifest point at the icon set, not the retired SVG icons', () => {
  const html = read('index.html');
  assert.ok(html.includes('<link rel="icon" href="/favicon.ico" sizes="any" />'));
  assert.ok(html.includes('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />'));
  assert.ok(read('reader.html').includes('href="/reader/favicon.ico"'));
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.deepStrictEqual(m.icons.map((i) => i.src), ['/icon-192.png', '/icon-512.png', '/icon-maskable-512.png']);
  assert.strictEqual(m.icons[2].purpose, 'maskable');
  for (const f of ['index.html', 'design-showcase.html', 'reader.html', 'sw.js']) {
    assert.ok(!read(f).includes('favicon.svg') && !read(f).includes('reader-icon'), `${f} references a retired icon`);
  }
  for (const f of ['favicon.svg', 'reader-icon.svg', 'reader-icon-192.png']) assert.ok(!fs.existsSync(pub(f)), `${f} removed`);
});

test('service worker cache version was bumped past v5 so the old icons are evicted', () => {
  const m = /bookhunt-shell-v(\d+)/.exec(read('sw.js'));
  assert.ok(m && Number(m[1]) >= 6);
});
