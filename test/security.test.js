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
  const req = { headers: { 'cf-connecting-ip': '1.2.3.4' }, socket: { remoteAddress: '203.0.113.9' } };
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
  // Real, distinct socket peers — an untrusted CF-Connecting-IP header alone
  // must NOT be enough to buy separate budgets (see the isTrustedProxyPeer
  // tests below); two different clients are told apart by their actual
  // connection, same as any request that didn't come through the tunnel.
  limit({ headers: { 'cf-connecting-ip': 'a' }, socket: { remoteAddress: '203.0.113.1' } }, resA, () => (aOk = true));
  limit({ headers: { 'cf-connecting-ip': 'b' }, socket: { remoteAddress: '203.0.113.2' } }, resB, () => (bOk = true));
  assert.equal(aOk, true);
  assert.equal(bOk, true);
});

test('clientIp: trusts CF-Connecting-IP only from a loopback/private peer (issue #37)', () => {
  // The docker-mapped tunnel path: real requests land with a private peer
  // (verified against the running container — loopback inside the container's
  // own namespace, the docker bridge gateway for host-forwarded traffic).
  assert.equal(
    security.clientIp({ headers: { 'cf-connecting-ip': '9.9.9.9' }, socket: { remoteAddress: '127.0.0.1' } }),
    '9.9.9.9'
  );
  assert.equal(
    security.clientIp({ headers: { 'cf-connecting-ip': '9.9.9.9' }, socket: { remoteAddress: '172.22.0.1' } }),
    '9.9.9.9'
  );
});

test('clientIp: ignores CF-Connecting-IP from an untrusted (non-private) peer', () => {
  // A request that somehow reached the app with a real internet-routable
  // peer address can't buy a fresh rate-limit bucket just by setting a
  // header — the raw socket address is used instead.
  assert.equal(
    security.clientIp({ headers: { 'cf-connecting-ip': '9.9.9.9' }, socket: { remoteAddress: '203.0.113.5' } }),
    '203.0.113.5'
  );
});

test('clientIp: falls back to "unknown" with no header and no socket', () => {
  assert.equal(security.clientIp({ headers: {}, socket: undefined }), 'unknown');
});

test('isTrustedProxyPeer: accepts loopback and RFC1918 private ranges (+ IPv4-mapped IPv6)', () => {
  assert.equal(security.isTrustedProxyPeer('127.0.0.1'), true);
  assert.equal(security.isTrustedProxyPeer('::1'), true);
  assert.equal(security.isTrustedProxyPeer('::ffff:127.0.0.1'), true);
  assert.equal(security.isTrustedProxyPeer('172.22.0.1'), true); // docker bridge gateway, verified live
  assert.equal(security.isTrustedProxyPeer('10.0.0.5'), true);
  assert.equal(security.isTrustedProxyPeer('192.168.1.1'), true);
});

test('isTrustedProxyPeer: rejects public/internet addresses', () => {
  assert.equal(security.isTrustedProxyPeer('203.0.113.5'), false);
  assert.equal(security.isTrustedProxyPeer('8.8.8.8'), false);
  assert.equal(security.isTrustedProxyPeer(''), false);
  assert.equal(security.isTrustedProxyPeer(undefined), false);
});

test('isForumUrl: accepts forum.mobilism.org + subdomains over http(s)', () => {
  assert.equal(security.isForumUrl('https://forum.mobilism.org/viewtopic.php?t=1'), true);
  assert.equal(security.isForumUrl('http://mobilism.org/'), true);
  assert.equal(security.isForumUrl('https://dl.mobilism.org/x'), true);
});

test('isForumUrl: rejects other hosts, look-alikes, and non-http schemes', () => {
  assert.equal(security.isForumUrl('https://evil.com/'), false);
  // a look-alike host must not slip past the anchored regex
  assert.equal(security.isForumUrl('https://mobilism.org.evil.com/'), false);
  assert.equal(security.isForumUrl('https://notmobilism.org/'), false);
  assert.equal(security.isForumUrl('file:///etc/passwd'), false);
  assert.equal(security.isForumUrl('javascript:alert(1)'), false);
  assert.equal(security.isForumUrl(''), false);
  assert.equal(security.isForumUrl(null), false);
});
