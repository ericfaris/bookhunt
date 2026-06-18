'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');

// --- Web app manifest (issue #18) -------------------------------------------

test('manifest.webmanifest: valid JSON with the installability essentials', () => {
  const raw = fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8');
  const m = JSON.parse(raw);
  assert.equal(m.display, 'standalone');
  assert.ok(m.name && m.short_name, 'has name + short_name');
  assert.equal(m.start_url, '/');
  assert.match(m.theme_color, /^#/);
  assert.ok(Array.isArray(m.icons) && m.icons.length >= 1, 'has at least one icon');
  for (const icon of m.icons) {
    assert.ok(icon.src, 'icon has src');
    assert.ok(fs.existsSync(path.join(PUBLIC, icon.src.replace(/^\//, ''))), `icon exists: ${icon.src}`);
  }
});

// --- Service worker (issue #18) ---------------------------------------------

test('sw.js: caches the app shell and leaves API/warm to the network', () => {
  const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
  // Registers the three lifecycle handlers.
  for (const evt of ['install', 'activate', 'fetch']) {
    assert.ok(sw.includes(`addEventListener('${evt}'`), `handles ${evt}`);
  }
  // Never intercepts API or the live-browser proxy.
  assert.ok(sw.includes("startsWith('/api')"), 'skips /api');
  assert.ok(sw.includes("startsWith('/warm')"), 'skips /warm');
  // Caches the core shell assets.
  for (const asset of ['/index.html', '/style.css', '/app.js']) {
    assert.ok(sw.includes(asset), `shell includes ${asset}`);
  }
  // Network-first: the fetch handler must hit the network BEFORE falling back to
  // the cache, so a refresh always picks up a freshly deployed shell (the bug:
  // cache-first served the stale app until a hard reload).
  const fetchIdx = sw.indexOf('await fetch(req)');
  const matchIdx = sw.indexOf('caches.match(req)');
  assert.ok(fetchIdx >= 0, 'fetch handler goes to the network');
  assert.ok(matchIdx >= 0, 'fetch handler can fall back to the cache');
  assert.ok(fetchIdx < matchIdx, 'network is tried before the cache (network-first)');
});

test('index.html: links the manifest and registers nothing inline (CSP-safe)', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.ok(html.includes('rel="manifest"'), 'links the manifest');
  // SW registration must live in app.js, not an inline <script> (blocked by CSP).
  assert.ok(!/<script>[^<]*serviceWorker/i.test(html), 'no inline SW registration');
});
