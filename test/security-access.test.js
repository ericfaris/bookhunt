'use strict';

// Cloudflare Access verification with Access ENABLED. security.js reads its
// config at load time, so this file sets the env first (node --test runs each
// file in its own process). fetch is stubbed; tokens are real RS256 JWTs
// signed with a throwaway key.

process.env.CF_ACCESS_TEAM_DOMAIN = 'team.cloudflareaccess.com';
process.env.CF_ACCESS_AUD = 'aud-123';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const security = require('../src/security');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };

function b64(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function makeToken({ kid = 'k1', aud = 'aud-123', key = privateKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', kid, typ: 'JWT' });
  const body = b64({ aud: [aud], iss: 'https://team.cloudflareaccess.com', exp: now + 600, iat: now, email: 'a@b.c' });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

function mockRes() {
  return {
    headers: {},
    statusCode: 200,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

const realFetch = global.fetch;
let fetchCalls;
const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ keys: [JWK] }) });
const dnsDownFetch = async () => {
  const err = new TypeError('fetch failed');
  err.cause = new Error('getaddrinfo EAI_AGAIN team.cloudflareaccess.com');
  throw err;
};
function useFetch(fn) {
  global.fetch = async (...args) => {
    fetchCalls++;
    return fn(...args);
  };
}

let warnings;
const realWarn = console.warn;
beforeEach(() => {
  security.resetKeysCacheForTest();
  fetchCalls = 0;
  warnings = [];
  console.warn = (msg) => warnings.push(String(msg));
});
afterEach(() => {
  global.fetch = realFetch;
  console.warn = realWarn;
});

async function callMiddleware(token) {
  const mw = security.cloudflareAccess();
  const res = mockRes();
  let nexted = false;
  await mw({ path: '/', headers: { 'cf-access-jwt-assertion': token } }, res, () => (nexted = true));
  return { res, nexted };
}

test('valid token passes with keys fetched', async () => {
  useFetch(okFetch);
  assert.equal(security.ACCESS_ENABLED, true);
  const payload = await security.verifyAccessToken(makeToken());
  assert.equal(payload.email, 'a@b.c');
});

test('network failure with an empty cache -> 503 + "JWKS unreachable", not 401', async () => {
  useFetch(dnsDownFetch);
  const { res, nexted } = await callMiddleware(makeToken());
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers['retry-after'], '10');
  assert.ok(warnings.some((w) => /Access JWKS unreachable: .*EAI_AGAIN/.test(w)), warnings.join('\n'));
  assert.ok(!warnings.some((w) => /Access token rejected/.test(w)), 'must not log as a token rejection');
});

test('non-OK JWKS response is also "unavailable"', async () => {
  useFetch(async () => ({ ok: false, status: 502, json: async () => ({}) }));
  await assert.rejects(security.verifyAccessToken(makeToken()), { code: 'JWKS_UNAVAILABLE' });
});

test('refresh failure with stale cached keys still verifies a valid token, and backs off', async () => {
  useFetch(okFetch);
  await security.verifyAccessToken(makeToken());
  // Age the cache past its TTL, then take the network down.
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 60 * 60 * 1000;
  try {
    useFetch(dnsDownFetch);
    fetchCalls = 0;
    const payload = await security.verifyAccessToken(makeToken());
    assert.equal(payload.email, 'a@b.c');
    assert.ok(warnings.some((w) => /using cached keys/.test(w)));
    await security.verifyAccessToken(makeToken());
    assert.equal(fetchCalls, 1, 'stale keys are reused without refetching on every request');
  } finally {
    Date.now = realNow;
  }
});

test('bad signature still -> 401 "Access token rejected"', async () => {
  useFetch(okFetch);
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const { res } = await callMiddleware(makeToken({ key: other }));
  assert.equal(res.statusCode, 401);
  assert.ok(warnings.some((w) => /Access token rejected: bad signature/.test(w)));
});

test('bad audience still -> 401', async () => {
  useFetch(okFetch);
  const { res } = await callMiddleware(makeToken({ aud: 'someone-else' }));
  assert.equal(res.statusCode, 401);
  assert.ok(warnings.some((w) => /Access token rejected: bad audience/.test(w)));
});

test('kid miss + failed forced refresh -> 503, even with other keys cached', async () => {
  useFetch(okFetch);
  await security.verifyAccessToken(makeToken()); // caches k1
  useFetch(dnsDownFetch);
  const { res } = await callMiddleware(makeToken({ kid: 'rotated' }));
  assert.equal(res.statusCode, 503);
});

test('kid miss with a working refresh but still unknown -> 401', async () => {
  useFetch(okFetch);
  const { res } = await callMiddleware(makeToken({ kid: 'nope' }));
  assert.equal(res.statusCode, 401);
  assert.ok(warnings.some((w) => /unknown signing key/.test(w)));
});

test('isUpgradeAuthorized: unavailable JWKS -> false, logged as unreachable', async () => {
  useFetch(dnsDownFetch);
  const ok = await security.isUpgradeAuthorized({ headers: { 'cf-access-jwt-assertion': makeToken() } });
  assert.equal(ok, false);
  assert.ok(warnings.some((w) => /JWKS unreachable \(upgrade\)/.test(w)));
});

test('warmAccessKeys: retries in the background until the fetch succeeds', async () => {
  let n = 0;
  useFetch(async (...a) => (++n < 3 ? dnsDownFetch(...a) : okFetch(...a)));
  await security.warmAccessKeys({ retryMs: 5, maxRetryMs: 10 });
  for (let i = 0; i < 50 && n < 3; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(n, 3);
  assert.ok(warnings.some((w) => /at startup; retrying in background/.test(w)));
  // Cache is warm now: verification needs no further fetch.
  fetchCalls = 0;
  await security.verifyAccessToken(makeToken());
  assert.equal(fetchCalls, 0);
});
