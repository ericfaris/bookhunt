'use strict';

// Reader portal routes (/reader/*): the magic-link shelf, its assets and API.
// Mounted BEFORE the operator app's static files — the only surface outside
// Cloudflare Access (see security.cloudflareAccess).

const path = require('path');
const express = require('express');
const { requireReader } = require('./http');

const security = require('../security');
const coverstore = require('../coverstore');
const watchlist = require('../watchlist');
const reader = require('../reader');
const { PUBLIC_DIR, readerPageHtml } = require('../assets');

const router = express.Router();

// --- Reader portal (issue #34) ----------------------------------------------
// Magic-link book picker for recipients — the ONLY surface outside Cloudflare
// Access (path-scoped CF bypass app at the edge; cloudflareAccess() skips it
// origin-side). Auth = per-recipient token, resolved constant-time; invalid
// tokens 404 so the route doesn't confirm which tokens exist. Tighter rate
// limit than the operator API: readers browse and tap, they don't hammer.
// Reader cover images (see coverstore). Registered BEFORE the /reader rate
// limit: a shelf page loads one image per tile, which would blow through 40/min
// on its own. Still token-gated, with its own (looser) limit; an image is
// resolved once per book and then served from disk.
router.get('/reader/cover', security.rateLimiter({ windowMs: 60_000, max: 600 }), requireReader({ json: false }), async (req, res) => {
  try {
    const img = await reader.coverImageForReader(String(req.query.id || '').slice(0, 100));
    if (!img) return res.status(404).end();
    coverstore.send(res, img);
  } catch (err) {
    console.error('Reader cover failed:', err);
    res.status(500).end();
  }
});

router.use('/reader', security.rateLimiter({ windowMs: 60_000, max: 40 }));

// Reader API responses are personal (name, books, sent-state) and the URLs
// carry the token — never let a browser or intermediary cache them.
router.use('/reader/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

router.get('/reader', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(readerPageHtml());
});

// The page's script must live under /reader/* too — anywhere else and the CF
// Access wall (which readers can't pass) would block it.
router.get('/reader/app.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'reader.js'));
});

// Per-reader web app manifest (home-screen install). Token from the query is
// baked into start_url so the installed icon opens THIS reader's shelf. Must
// live under /reader/* to clear Cloudflare Access.
router.get('/reader/manifest.webmanifest', (req, res) => {
  const r = reader.byToken(String(req.query.t || ''));
  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Cache-Control', 'no-cache');
  res.json(reader.buildManifest(r ? r.readerToken : ''));
});

// App icons for the home-screen install — also under /reader/* for CF Access.
// Same files as the admin app's icon set (built by scripts/icons/build.py).
const READER_ICONS = {
  '180': 'apple-touch-icon.png', '192': 'icon-192.png', '512': 'icon-512.png', 'maskable-512': 'icon-maskable-512.png',
};
router.get('/reader/icon-:size.png', (req, res) => {
  const file = READER_ICONS[req.params.size] || READER_ICONS['192'];
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(PUBLIC_DIR, file));
});
// The display font, for the same reason (public/fonts, Nunito, SIL OFL).
router.get('/reader/fonts/nunito-latin-wght.woff2', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  res.type('font/woff2');
  res.sendFile(path.join(PUBLIC_DIR, 'fonts', 'nunito-latin-wght.woff2'));
});
router.get('/reader/favicon.ico', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(PUBLIC_DIR, 'favicon.ico'));
});

router.get('/reader/api/books', requireReader(), async (req, res) => {
  const r = req.reader;
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || reader.PAGE_SIZE));
  try {
    const { books, total, hasMore } = await reader.booksForReaderPage(r, offset, limit);
    res.json({ name: r.name, kindleSet: !!r.kindleEmail, books, total, hasMore, offset, limit });
  } catch (err) {
    console.error('Reader books failed:', err);
    res.status(500).json({ error: 'Could not load the shelf.' });
  }
});

router.get('/reader/api/search', requireReader(), async (req, res) => {
  const r = req.reader;
  const q = String(req.query.q || '').slice(0, 300).trim();
  try {
    const books = q ? await reader.searchForReader(r, q) : [];
    res.json({ name: r.name, kindleSet: !!r.kindleEmail, books, query: q });
  } catch (err) {
    console.error('Reader search failed:', err);
    res.status(500).json({ error: 'Search failed.' });
  }
});

// Tap-a-book details modal: larger cover + catalog blurb for ONE shelf book.
// Same token gate as the rest; unknown/unsendable ids 404 like a bad token.
router.get('/reader/api/book', requireReader(), async (req, res) => {
  const r = req.reader;
  const id = String(req.query.id || '').slice(0, 100);
  try {
    const book = await reader.bookDetailsForReader(r, id);
    if (!book) return res.status(404).json({ error: 'Not found' });
    res.json({ kindleSet: !!r.kindleEmail, book });
  } catch (err) {
    console.error('Reader book details failed:', err);
    res.status(500).json({ error: 'Could not load that book.' });
  }
});

router.post('/reader/api/watchlist', requireReader(), (req, res) => {
  const { title, author } = req.body || {};
  const r = req.reader;
  try {
    const cleaned = watchlist.cleanWatchInput({ title, author, recipientIds: [r.id] });
    const plan = reader.planReaderWatch(watchlist.readAll(), cleaned, r.id);
    if (plan.action === 'merge') watchlist.setRecipients(plan.id, plan.recipientIds);
    else watchlist.add(plan.input);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not add the watch.' });
  }
});

router.post('/reader/api/send', requireReader(), async (req, res) => {
  const { id } = req.body || {};
  const r = req.reader;
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Missing book id.' });
  try {
    const out = await reader.sendToReader(r, id);
    res.json({ ok: true, title: out.title });
  } catch (err) {
    const status = err.code === 'no-kindle' ? 409 : err.code === 'gone' ? 410 : err.code === 'throttled' ? 429 : 500;
    if (status === 500) console.error('Reader send failed:', err);
    res.status(status).json({ error: err.message });
  }
});

router.post('/reader/api/unsubscribe', requireReader(), (req, res) => {
  reader.setReaderEnabled(req.reader.id, false);
  res.json({ ok: true });
});

module.exports = router;
