'use strict';

// Login checks on the hot paths: search/download trust the session cookie
// (no index.php round-trip), and gotoAuthed re-authenticates when a page comes
// back logged out instead of letting a dead session read as "no results".

const { test } = require('node:test');
const assert = require('node:assert');

process.env.MOBILISM_USER = process.env.MOBILISM_USER || 'test-user';
process.env.MOBILISM_PASS = process.env.MOBILISM_PASS || 'test-pass';
const { ensureReady, gotoAuthed, BASE_URL } = require('../src/searcher');

/** A fake Playwright page: `loggedInAfter(url)` decides what each load shows. */
function fakePage(loggedInFor) {
  const visits = [];
  let current = null;
  return {
    visits,
    async goto(url) { visits.push(url); current = url; },
    async evaluate() { return loggedInFor(current, visits); }, // isLoggedIn's probe
    async title() { return 'Mobilism'; },
    async $() { return null; },
    async fill() {}, async check() {}, async click() {},
    async waitForSelector() {}, async waitForTimeout() {},
  };
}

test('ensureReady({ trustCookie }): logged-in cookie → no navigation at all', async () => {
  const page = fakePage(() => true);
  await ensureReady(page, { trustCookie: true, status: async () => ({ loggedIn: true }) });
  assert.deepEqual(page.visits, []);
});

test('ensureReady({ trustCookie }): no login cookie → full check via index.php', async () => {
  const page = fakePage(() => true);
  await ensureReady(page, { trustCookie: true, status: async () => ({ loggedIn: false }) });
  assert.deepEqual(page.visits, [`${BASE_URL}/index.php`]);
});

test('ensureReady(): default (reupload/thanks paths) still always does the full check', async () => {
  const page = fakePage(() => true);
  await ensureReady(page);
  assert.deepEqual(page.visits, [`${BASE_URL}/index.php`]);
});

test('ensureReady: a failed login is typed needWarm', async () => {
  const page = fakePage(() => false);
  await assert.rejects(ensureReady(page), (err) => err.needWarm === true);
});

test('gotoAuthed: logged-in page → one load, no re-login', async () => {
  const page = fakePage(() => true);
  await gotoAuthed(page, `${BASE_URL}/search.php?keywords=x`);
  assert.deepEqual(page.visits, [`${BASE_URL}/search.php?keywords=x`]);
});

test('gotoAuthed: page shows logged out (cookie outlived the session) → login, then reload once', async () => {
  const url = `${BASE_URL}/viewtopic.php?t=1`;
  // Logged out on the first load; the login (index.php) succeeds; the reload is logged in.
  const page = fakePage((current, visits) => visits.length > 1);
  await gotoAuthed(page, url);
  assert.deepEqual(page.visits, [url, `${BASE_URL}/index.php`, url]);
});

test('gotoAuthed: login impossible → throws needWarm instead of returning a logged-out page', async () => {
  const page = fakePage(() => false);
  await assert.rejects(gotoAuthed(page, `${BASE_URL}/search.php`), (err) => err.needWarm === true);
});
