'use strict';

// Regression: Cloudflare's Browser Cache TTL rewrites our JS/CSS to
// max-age=14400 regardless of origin no-cache, so after a deploy browsers ran
// the OLD app.js/style.css against the NEW index.html for hours. The shell is
// now served with content-hashed asset URLs (stampAssets in src/server.js).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-cachebust-'));
process.env.HISTORY_FILE = path.join(TMP, 'history.json');
process.env.RECIPIENTS_FILE = path.join(TMP, 'recipients.json');
process.env.CF_ACCESS_TEAM_DOMAIN = '';
process.env.CF_ACCESS_AUD = '';

const { test } = require('node:test');
const assert = require('node:assert');
const { app } = require('../src/server');
const { request, withServer } = require('./http-helpers');

const PUBLIC = path.join(__dirname, '..', 'public');
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC, f))).digest('hex').slice(0, 12);

for (const route of ['/', '/index.html']) {
  test(`GET ${route}: app.js and style.css carry content hashes`, async () => {
    await withServer(app, async (port) => {
      const res = await request(port, 'GET', route);
      assert.equal(res.status, 200);
      assert.ok(res.body.includes(`<script src="app.js?v=${hash('app.js')}"></script>`), 'versioned script');
      assert.ok(res.body.includes(`<link rel="stylesheet" href="style.css?v=${hash('style.css')}" />`), 'versioned stylesheet');
      assert.ok(!res.body.includes('src="app.js"'), 'no unversioned script left');
      assert.ok(!res.body.includes('href="style.css"'), 'no unversioned stylesheet left');
      assert.ok(res.body.includes('id="libraryList"'), 'still the full app shell');
    });
  });
}

test('versioned asset URLs serve the real files', async () => {
  await withServer(app, async (port) => {
    const js = await request(port, 'GET', `/app.js?v=${hash('app.js')}`);
    assert.equal(js.status, 200);
    assert.equal(js.body, fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8'));
    const css = await request(port, 'GET', `/style.css?v=${hash('style.css')}`);
    assert.equal(css.status, 200);
    assert.equal(css.body, fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8'));
  });
});

test('every local <script>/<link rel=stylesheet> in the shell pages is versioned', async () => {
  // Guard against a future asset being added to a page but not to stampAssets.
  await withServer(app, async (port) => {
    for (const route of ['/', '/reader']) {
      const { body } = await request(port, 'GET', route);
      const refs = [...body.matchAll(/<script[^>]*\ssrc="([^"]+)"|<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)]
        .map((m) => m[1] || m[2])
        .filter((u) => !/^https?:/.test(u));
      assert.ok(refs.length, `${route} has local assets`);
      for (const u of refs) assert.match(u, /\?v=[a-f0-9]{12}$/, `${route}: ${u} is versioned`);
    }
  });
});

test('backfill removed: POST /api/lists/backfill/start is gone; /api/status has no backfill block', async () => {
  await withServer(app, async (port) => {
    const res = await request(port, 'POST', '/api/lists/backfill/start', {});
    assert.equal(res.status, 404);
    const st = await request(port, 'GET', '/api/status');
    assert.equal(st.status, 200);
    assert.ok(st.json.lists && !('backfill' in st.json.lists));
  });
});
