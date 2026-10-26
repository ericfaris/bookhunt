'use strict';

// Recipient routes: people, reader-portal management, groups, notification
// channel status + test send.

const express = require('express');

const recipients = require('../recipients');
const notify = require('../notify');
const kindle = require('../kindle');
const reader = require('../reader');

const router = express.Router();

// --- Notification recipients ------------------------------------------------
router.get('/api/recipients', (_req, res) => {
  res.json({ recipients: recipients.readAll() });
});

router.post('/api/recipients', (req, res) => {
  try {
    const entry = recipients.add(req.body || {});
    res.json({ recipient: entry });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Edit a recipient IN PLACE (issue #7 fix) — deliberately NOT delete+re-add,
// which would mint a new id and readerToken and break that person's magic
// link, their installed home-screen app, and every watch's recipientIds that
// pointed at the old id.
router.put('/api/recipients/:id', (req, res) => {
  try {
    const updated = recipients.update(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Recipient not found.' });
    res.json({ recipient: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/api/recipients/:id', (req, res) => {
  const removed = recipients.remove(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Recipient not found.' });
  res.json({ ok: true });
});

// --- Reader portal management (operator side, behind CF Access) --------------
// Invite emails the recipient their magic link (minting a token if needed and
// re-enabling their new-book emails).
router.post('/api/recipients/:id/invite', async (req, res) => {
  try {
    const r = await reader.invite(req.params.id);
    res.json({ ok: true, link: reader.readerLink(r) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Rotate the token: the old link dies instantly (leaked-link kill switch).
router.post('/api/recipients/:id/reader-token', (req, res) => {
  const r = reader.rotateToken(req.params.id);
  if (!r) return res.status(404).json({ error: 'Recipient not found.' });
  res.json({ ok: true, link: reader.readerLink(r) });
});

// Toggle whether they receive new-book emails (their link keeps working).
router.post('/api/recipients/:id/reader', (req, res) => {
  const r = reader.setReaderEnabled(req.params.id, !!(req.body || {}).enabled);
  if (!r) return res.status(404).json({ error: 'Recipient not found.' });
  res.json({ ok: true, readerEnabled: r.readerEnabled });
});

// --- Recipient groups (presets) ---------------------------------------------
router.get('/api/recipient-groups', (_req, res) => {
  res.json({ groups: recipients.readGroups() });
});

router.post('/api/recipient-groups', (req, res) => {
  try {
    const group = recipients.addGroup(req.body || {});
    res.json({ group });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/api/recipient-groups/:id', (req, res) => {
  const removed = recipients.removeGroup(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Group not found.' });
  res.json({ ok: true });
});

// --- Notification channel status (drives the Send UI) -----------------------
router.get('/api/notify/status', (_req, res) => {
  res.json({ channels: notify.listChannels(), kindle: kindle.isConfigured() });
});

// --- Send a test email (Settings panel: verify SMTP end-to-end) -------------
router.post('/api/notify/test', async (req, res) => {
  const email = typeof (req.body && req.body.email) === 'string' ? req.body.email.trim() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  try {
    await notify.sendTest(email);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Test send failed.' });
  }
});

module.exports = router;
