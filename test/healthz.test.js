'use strict';

// Integration test for /healthz (issue #39). Docker's in-container healthcheck
// probe has no Cloudflare Access token — /healthz must stay reachable and
// return 200 regardless, which only works because it's mounted BEFORE the
// Access-verification middleware in src/server.js. Enable Access verification
// here (real values aren't needed — no token means the request never gets far
// enough to need JWKS) so the test actually exercises that ordering rather
// than trivially passing because Access is off.
process.env.CF_ACCESS_TEAM_DOMAIN = 'example.cloudflareaccess.com';
process.env.CF_ACCESS_AUD = 'test-aud';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { app } = require('../src/server');

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      })
      .on('error', reject);
  });
}

test('/healthz: 200 with no token, even with Cloudflare Access verification ON', async () => {
  const server = await listen();
  try {
    const { status, body } = await get(server.address().port, '/healthz');
    assert.equal(status, 200);
    assert.deepEqual(JSON.parse(body), { ok: true });
  } finally {
    server.close();
  }
});

test('/api/history: still 401s with no token — confirms Access verification is genuinely ON in this test (healthz is the deliberate exception, not a broken gate)', async () => {
  const server = await listen();
  try {
    const { status } = await get(server.address().port, '/api/history');
    assert.equal(status, 401);
  } finally {
    server.close();
  }
});
