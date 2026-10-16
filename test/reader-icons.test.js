'use strict';

// The reader Library is installed by people outside Cloudflare Access, so its
// icons are served under /reader/* (bypassed at the edge and at the origin).
// They're the same files as the admin icon set; these pin the size → file map
// and that the origin's Access check lets them through without a token.
process.env.CF_ACCESS_TEAM_DOMAIN = 'example.cloudflareaccess.com';
process.env.CF_ACCESS_AUD = 'test-aud';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('../src/server');
const { listen } = require('./http-helpers');

const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f));

test('/reader icons serve the shared icon set without an Access token', async () => {
  const server = await listen(app);
  const port = server.address().port;
  try {
    const cases = {
      '/reader/icon-180.png': 'apple-touch-icon.png',
      '/reader/icon-192.png': 'icon-192.png',
      '/reader/icon-512.png': 'icon-512.png',
      '/reader/icon-maskable-512.png': 'icon-maskable-512.png',
      '/reader/icon-999.png': 'icon-192.png', // unknown size falls back
      '/reader/favicon.ico': 'favicon.ico',
    };
    for (const [url, file] of Object.entries(cases)) {
      const res = await fetch(`http://127.0.0.1:${port}${url}`);
      assert.strictEqual(res.status, 200, url);
      assert.ok(Buffer.from(await res.arrayBuffer()).equals(pub(file)), `${url} serves ${file}`);
    }
  } finally {
    server.close();
  }
});
