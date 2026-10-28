'use strict';

// The admin app is a set of routed, full-width pages (2026-10 navigation
// rework). These pin the structure the router and the reviewed fixes depend
// on: one page per nav link, no leftover overlay screens, Back-friendly hash
// routes, and the rebuilt Readers / Watchlist / Activity / mega view.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');

const PAGES = ['search', 'library', 'watchlist', 'readers', 'activity', 'settings'];

test('every nav link has a matching page section and router entry', () => {
  for (const p of PAGES) {
    assert.ok(html.includes(`data-route="${p}"`), `nav link for ${p}`);
    assert.ok(html.includes(`data-page="${p}"`), `page section for ${p}`);
    assert.match(js, new RegExp(`\\b${p}: \\{ title: '`), `ROUTES entry for ${p}`);
  }
  assert.match(html, /<a href="#\/library" data-route="library">Library<\/a>/);
});

test('old overlay screens are gone (pages replace them)', () => {
  for (const id of ['libraryPanel', 'historyPanel', 'watchlistModal', 'settingsModal', 'statusModal', 'recipientsModal', 'reupReqModal', 'managePanel', 'overlay']) {
    assert.ok(!html.includes(`id="${id}"`), `${id} removed from markup`);
    assert.ok(!js.includes(`$('#${id}')`), `${id} not referenced in app.js`);
  }
});

test('router: hash routes, hashchange listener, aria-current, per-page titles', () => {
  assert.ok(js.includes("window.addEventListener('hashchange', showRoute)"));
  assert.ok(js.includes("a.setAttribute('aria-current', 'page')"));
  assert.ok(js.includes('· BookHunt`'), 'page-specific document titles');
  assert.ok(js.includes('showRoute();\nprefillFromQuery();'), 'router runs before the deep-link prefill');
});

test('Readers page: labeled actions, confirmations, no alert() popups', () => {
  for (const label of ["'Re-invite'", "'Copy link'", "'New link'", "'Edit'", "'Delete'"]) assert.ok(js.includes(label), label);
  assert.match(js, /confirmDialog\(\{\s*title: `Delete \$\{r\.name\}\?`/);
  assert.ok(!/\balert\(/.test(js), 'no alert() left in app.js');
  assert.ok(html.includes('class="data-table readers-table"'));
});

test('Watchlist page: status tabs with counts; text-labeled row actions', () => {
  assert.ok(js.includes("['expired', 'Expired'"));
  assert.ok(js.includes("w.status === 'paused' ? 'Resume' : 'Pause'"));
  assert.ok(!js.includes('watch-icon-btn') && !js.includes("'⏸'"), 'no icon-only pause/delete buttons on watches');
});

test('Watchlist page: failures get their own first tab and an honest badge (critique 2026-10-27)', () => {
  assert.ok(js.indexOf("['attention', 'Needs attention'") < js.indexOf("['active', 'Active'"), 'triage tab comes first');
  assert.ok(js.includes("if (!watchTab) watchTab = allWatches.some(watchNeedsAttention) ? 'attention' : 'active';"));
  assert.ok(js.includes('`Download failing (${w.downloadMisses}/${watchMaxMisses})`'));
  assert.ok(js.includes("w.fulfilledBy === 'library'") && js.includes("'In your Library ✓'"));
  assert.ok(!js.includes('Found — retrying download'), 'old badge that read like success is gone');
  assert.ok(css.includes('.badge.warn-badge'));
  assert.ok(js.includes("} else if (w.fulfilledBy !== 'library') {"), 'no "Watch again" for a book you already have');
});

test('Activity page: day groups, type filters, sends rendered as sends, no file paths', () => {
  assert.ok(js.includes('function dayLabel('));
  assert.ok(js.includes("['notify', 'Sends']"));
  assert.ok(js.includes('to their Kindle from their Library'));
  assert.ok(!js.includes("entry.savePath ? ` → ${entry.savePath}`"), 'raw save paths no longer shown');
});

test('mega view: dialog markup, blurred see-through backdrop, keyboard + backdrop close', () => {
  assert.match(html, /<div id="mega" class="mega" role="dialog" aria-modal="true" aria-labelledby="megaTitle" hidden>/);
  assert.match(css, /\.mega \{[^}]*backdrop-filter: blur\(/);
  assert.match(css, /\.mega \{[^}]*color-mix\(in srgb, var\(--bg\) \d+%, transparent\)/, 'translucent, not opaque');
  assert.ok(js.includes("if (megaIsOpen()) return closeMega();"), 'Esc closes');
  assert.ok(js.includes("e.key === 'ArrowLeft'") && js.includes("e.key === 'ArrowRight'"), 'arrow keys step');
  assert.ok(js.includes("if (e.target === mega || e.target === $('#megaStage')) closeMega();"), 'backdrop click closes');
});

test('Library page: sort, show filter, paging', () => {
  for (const id of ['librarySort', 'libraryShow', 'libraryMore']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(js.includes('function sortLibrary('));
  assert.ok(js.includes('const LIBRARY_PAGE = 60;'));
});

test('Library is the landing page; Search lives at #/search', () => {
  assert.ok(js.includes("return m && ROUTES[m[1]] ? m[1] : 'library';"), 'unknown/empty hash falls back to Library');
  assert.ok(js.includes("let currentRoute = 'library';"));
  assert.match(html, /<a href="#\/search" data-route="search">Search<\/a>/);
  assert.ok(!html.includes('href="#/"'), 'no nav link still pointing at the bare root');
  assert.ok(!js.includes("href: '#/' }"), 'in-app links to Search use #/search');
  // The markup's initial visibility matches the default route (no flash of Search).
  assert.match(html, /data-page="library" aria-labelledby="libraryHeading">/);
  assert.match(html, /data-page="search" aria-labelledby="searchHeading" hidden>/);
  // Library is listed first in the nav.
  assert.ok(html.indexOf('data-route="library"') < html.indexOf('data-route="search"'));
});

test('deep-link prefill (?title= / ?amazon=) switches to the Search page', () => {
  assert.ok(js.includes("history.replaceState(null, '', `${location.pathname}#/search`); showRoute();"));
});

test('app.js: one shared /api/library request; session poll skips hidden tabs', () => {
  assert.equal((js.match(/fetch\('\/api\/library'\)/g) || []).length, 1, 'all callers go through fetchLibrary()');
  assert.match(js, /setInterval\(\(\) => \{ if \(document\.visibilityState === 'visible'\) refreshSessionStatus\(\); \}, 30000\)/);
  assert.match(js, /addEventListener\('visibilitychange'/);
});
