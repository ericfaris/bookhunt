'use strict';

// Defense-in-depth middleware for an app exposed through a Cloudflare Tunnel.
//
// The primary gate is Cloudflare Access (a login policy on read.mooseflip.com).
// Everything here assumes that gate could fail or be bypassed — if someone
// discovers the origin/tunnel hostname, or the Access policy is ever loosened,
// these layers keep the app from being wide open:
//
//   - cloudflareAccess(): verifies the signed Cf-Access-Jwt-Assertion JWT that
//     Cloudflare injects on every authenticated request, against your team's
//     public keys (JWKS). A request that didn't pass through Access has no valid
//     token and is rejected with 401. This makes the origin FAIL CLOSED.
//   - securityHeaders(): CSP + clickjacking/sniffing/referrer hardening.
//   - rateLimiter(): caps requests per client IP to blunt brute-force / abuse.
//
// No third-party deps: JWT verification uses Node's built-in crypto (JWK ->
// public key) and global fetch for the JWKS endpoint.

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(), microphone=(), camera=(), payment=(), usb=()'
  );

  // The /warm route proxies noVNC, which ships its own inline scripts, styles,
  // and web workers — a strict CSP would break the live-browser view. Scope CSP
  // to the app's own pages and let noVNC manage its own surface.
  if (!req.path.startsWith('/warm')) {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "img-src 'self' data: https:", // book covers are hot-linked from Amazon
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self'",
        "font-src 'self' data:",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'",
      ].join('; ')
    );
  }
  next();
}

// ---------------------------------------------------------------------------
// Cloudflare Access JWT verification
// ---------------------------------------------------------------------------
const TEAM_DOMAIN = (process.env.CF_ACCESS_TEAM_DOMAIN || '')
  .replace(/^https?:\/\//, '')
  .replace(/\/+$/, '')
  .trim();
const AUD = (process.env.CF_ACCESS_AUD || '').trim();
// Optional extra allowlist: even with a valid Access token, only these emails
// get through. Belt-and-suspenders on top of the Access policy itself.
const ALLOWED_EMAILS = (process.env.CF_ACCESS_ALLOWED_EMAILS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const ACCESS_ENABLED = !!(TEAM_DOMAIN && AUD);

// JWKS cache (Cloudflare rotates signing keys; cache for an hour, refetch on a
// kid miss in case a rotation just happened).
let keysCache = { keys: [], at: 0 };
const KEYS_TTL_MS = 60 * 60 * 1000;

async function getKeys(force) {
  if (!force && keysCache.keys.length && Date.now() - keysCache.at < KEYS_TTL_MS) {
    return keysCache.keys;
  }
  const res = await fetch(`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
  const body = await res.json();
  keysCache = { keys: Array.isArray(body.keys) ? body.keys : [], at: Date.now() };
  return keysCache.keys;
}

function decodeSegment(seg) {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

async function verifyAccessToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');

  const header = decodeSegment(parts[0]);
  if (header.alg !== 'RS256') throw new Error(`unexpected alg ${header.alg}`);

  let keys = await getKeys(false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await getKeys(true); // maybe keys just rotated — force a refresh once
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error('unknown signing key');

  const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const signedOk = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    pub,
    Buffer.from(parts[2], 'base64url')
  );
  if (!signedOk) throw new Error('bad signature');

  const payload = decodeSegment(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now > payload.exp + 10) throw new Error('token expired');
  if (payload.nbf && now < payload.nbf - 10) throw new Error('token not yet valid');
  if (payload.iss && payload.iss !== `https://${TEAM_DOMAIN}`) {
    throw new Error('bad issuer');
  }
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(AUD)) throw new Error('bad audience');
  if (
    ALLOWED_EMAILS.length &&
    !ALLOWED_EMAILS.includes(String(payload.email || '').toLowerCase())
  ) {
    throw new Error('email not allowed');
  }
  return payload;
}

// Cloudflare presents the token as a request header on proxied HTTP requests and
// as a cookie (CF_Authorization) on WebSocket upgrades / direct browser loads.
function tokenFromHeaders(headers) {
  const h = headers['cf-access-jwt-assertion'];
  if (h) return Array.isArray(h) ? h[0] : h;
  const cookie = headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Express middleware. No-op (but warns) when not configured, so local dev still
// works; enforced and fail-closed once CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD set.
function cloudflareAccess() {
  if (!ACCESS_ENABLED) {
    console.warn(
      '[security] Cloudflare Access verification is OFF (set CF_ACCESS_TEAM_DOMAIN ' +
        '+ CF_ACCESS_AUD to enforce). The app is only as protected as your ' +
        'Cloudflare Access policy / network exposure.'
    );
    return (_req, _res, next) => next();
  }
  console.log(`[security] Cloudflare Access verification ON (team ${TEAM_DOMAIN})`);
  return async (req, res, next) => {
    const token = tokenFromHeaders(req.headers);
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
      req.cfAccess = await verifyAccessToken(token);
      next();
    } catch (err) {
      console.warn(`[security] Access token rejected: ${err.message}`);
      res.status(401).json({ error: 'Unauthorized' });
    }
  };
}

// For WebSocket upgrades, which bypass Express middleware. Resolves true/false.
async function isUpgradeAuthorized(req) {
  if (!ACCESS_ENABLED) return true;
  const token = tokenFromHeaders(req.headers);
  if (!token) return false;
  try {
    await verifyAccessToken(token);
    return true;
  } catch (err) {
    console.warn(`[security] Access upgrade rejected: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// In-memory per-IP rate limiter (fixed window). No external store needed for a
// single-process app; behind Cloudflare we key on CF-Connecting-IP.
// ---------------------------------------------------------------------------
function clientIp(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    (req.socket && req.socket.remoteAddress) ||
    'unknown'
  );
}

function rateLimiter({ windowMs = 60_000, max = 120 } = {}) {
  const hits = new Map();
  const timer = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, v] of hits) if (v.start < cutoff) hits.delete(k);
  }, windowMs);
  if (timer.unref) timer.unref(); // don't keep the process alive for cleanup

  return (req, res, next) => {
    const ip = clientIp(req);
    const now = Date.now();
    let rec = hits.get(ip);
    if (!rec || now - rec.start > windowMs) {
      rec = { start: now, count: 0 };
      hits.set(ip, rec);
    }
    rec.count++;
    if (rec.count > max) {
      res.setHeader('Retry-After', Math.ceil((rec.start + windowMs - now) / 1000));
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  };
}

module.exports = {
  securityHeaders,
  cloudflareAccess,
  isUpgradeAuthorized,
  rateLimiter,
  // exported for tests
  verifyAccessToken,
  tokenFromHeaders,
  ACCESS_ENABLED,
};
