'use strict';

// Small helpers shared by the route modules.

const reader = require('../reader');

/**
 * Express middleware: resolve the reader magic-link token (query `t` on GETs,
 * body `t` on POSTs) to req.reader, or 404 — an invalid token looks exactly
 * like a missing page, so the route never confirms which tokens exist.
 * `{ json: false }` answers with an empty 404 (image routes).
 */
function requireReader({ json = true } = {}) {
  return (req, res, next) => {
    const t = req.method === 'GET' ? req.query.t : (req.body || {}).t;
    const r = reader.byToken(String(t || ''));
    if (!r) return json ? res.status(404).json({ error: 'Not found' }) : res.status(404).end();
    req.reader = r;
    next();
  };
}

/**
 * Answer a failed forum operation: a stale Mobilism session (`needWarm`) or an
 * inactive watch (`notActive`) is a 409 the UI turns into a prompt; anything
 * else is a 500 with the error's message (or `fallback`).
 */
function sendError(res, err, fallback = 'Something went wrong.') {
  const e = err || {};
  if (e.needWarm) return res.status(409).json({ error: e.message, needWarm: true });
  if (e.notActive) return res.status(409).json({ error: e.message, notActive: true });
  return res.status(500).json({ error: e.message || fallback });
}

module.exports = { requireReader, sendError };
