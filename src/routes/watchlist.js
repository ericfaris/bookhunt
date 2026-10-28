'use strict';

// Watchlist routes (issue #7): saved searches the watcher re-runs.

const express = require('express');
const { sendError } = require('./http');

const recipients = require('../recipients');
const notify = require('../notify');
const library = require('../library');
const watchlist = require('../watchlist');
const watcher = require('../watcher');

const router = express.Router();

// --- Watchlist (issue #7) ---------------------------------------------------
// Saved searches the server re-runs on a schedule (src/watcher.js), notifying
// the user when a match finally appears. The list also reports whether email is
// configured (no email channel = notifications can't be delivered).
router.get('/api/watchlist', (_req, res) => {
  // Close watches for books that already reached the Library some other way,
  // so the page never shows "retrying" for a book you have. Best-effort.
  try { watcher.reconcileOwned(); } catch { /* the page still renders */ }
  // Newest-added first — readAll() is insertion order (oldest first), so sort
  // by createdAt desc for display; sort is a copy, doesn't touch storage order.
  const watches = [...watchlist.readAll()].sort(
    (a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0)
  );
  res.json({
    watches,
    emailReady: notify.listChannels().some((c) => c.id === 'email' && c.configured),
    notifyTo: watcher.operatorEmail() || null,
    maxDownloadMisses: watcher.MAX_DOWNLOAD_MISSES,
    // For relating recipients to a watch (id, name, whether they have a Kindle).
    recipients: recipients.readAll().map((r) => ({ id: r.id, name: r.name, hasKindle: !!r.kindleEmail })),
  });
});

router.post('/api/watchlist', (req, res) => {
  try {
    // Don't watch a book you already own — same guard the new-release radar
    // applies to auto-entrants, now on the manual path too. cleanWatchInput
    // validates/normalizes; ownsBook fails open so a lookup error never blocks
    // a legitimate watch.
    const cleaned = watchlist.cleanWatchInput(req.body || {});
    if (library.ownsBook(cleaned)) {
      return res.status(409).json({ error: 'That book is already in your Library.', owned: true });
    }
    const entry = watchlist.add(cleaned);
    res.json(entry);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not add the watch.' });
  }
});

router.delete('/api/watchlist/:id', (req, res) => {
  const ok = watchlist.remove(req.params.id);
  res.json({ ok });
});

// Pause / resume a watch.
router.post('/api/watchlist/:id/status', (req, res) => {
  try {
    const updated = watchlist.setStatus(req.params.id, (req.body || {}).status);
    if (!updated) return res.status(404).json({ error: 'Watch not found.' });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Relate recipients to a watch — who gets the book on Kindle + a notification
// when it's found (issue #7 follow-up).
router.post('/api/watchlist/:id/recipients', (req, res) => {
  const updated = watchlist.setRecipients(req.params.id, (req.body || {}).recipientIds);
  if (!updated) return res.status(404).json({ error: 'Watch not found.' });
  res.json(updated);
});

// "Check now" — run this watch immediately instead of waiting for the scheduler.
router.post('/api/watchlist/:id/check', async (req, res) => {
  try {
    const result = await watcher.checkNow(req.params.id);
    res.json(result);
  } catch (err) {
    sendError(res, err, 'Check failed.');
  }
});

module.exports = router;
