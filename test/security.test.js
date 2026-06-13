'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const security = require('../src/security');

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

test('securityHeaders: sets hardening headers + CSP on app pages', () => {
  const res = mockRes();
  let nexted = false;
  security.securityHeaders({ path: '/index.html' }, res, () => (nexted = true));
  assert.equal(nexted, true);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.match(res.headers['content-security-policy'], /default-src 'self'/);
});

test('securityHeaders: omits CSP on /warm so noVNC still works', () => {
  const res = mockRes();
  security.securityHeaders({ path: '/warm/vnc.html' }, res, () => {});
  assert.equal(res.headers['content-security-policy'], undefined);
  // baseline headers still applied
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('tokenFromHeaders: reads the assertion header and the cookie', () => {
  assert.equal(
    security.tokenFromHeaders({ 'cf-access-jwt-assertion': 'abc' }),
    'abc'
  );
  assert.equal(
    security.tokenFromHeaders({ cookie: 'foo=1; CF_Authorization=xyz; bar=2' }),
    'xyz'
  );
  assert.equal(security.tokenFromHeaders({}), null);
});

test('rateLimiter: blocks after the cap and returns 429', () => {
  const limit = security.rateLimiter({ windowMs: 60_000, max: 3 });
  const req = { headers: { 'cf-connecting-ip': '1.2.3.4' }, socket: {} };
  let allowed = 0;
  let blocked = null;
  for (let i = 0; i < 5; i++) {
    const res = mockRes();
    limit(req, res, () => allowed++);
    if (res.statusCode === 429) blocked = res;
  }
  assert.equal(allowed, 3);
  assert.ok(blocked, 'expected a 429 once the cap was exceeded');
  assert.match(blocked.body.error, /too many/i);
});

test('rateLimiter: separate IPs have separate budgets', () => {
  const limit = security.rateLimiter({ windowMs: 60_000, max: 1 });
  const resA = mockRes();
  const resB = mockRes();
  let aOk = false;
  let bOk = false;
  limit({ headers: { 'cf-connecting-ip': 'a' }, socket: {} }, resA, () => (aOk = true));
  limit({ headers: { 'cf-connecting-ip': 'b' }, socket: {} }, resB, () => (bOk = true));
  assert.equal(aOk, true);
  assert.equal(bOk, true);
});
