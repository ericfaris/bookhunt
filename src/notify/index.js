'use strict';

// Channel-agnostic notification registry. Each channel module implements:
//   id, label, isConfigured(), supports(recipient), send({recipient, book})
// To add a channel (e.g. Twilio), drop a module here — callers don't change.

const channels = [require('./email'), require('./twilio')];

/** Status of every channel — used by the UI to show what's available. */
function listChannels() {
  return channels.map((c) => ({ id: c.id, label: c.label, configured: c.isConfigured() }));
}

function byId(channelId) {
  return channels.find((c) => c.id === channelId) || null;
}

/**
 * Notify one recipient over the requested channels (default: all). Skips
 * channels that aren't configured or don't apply to the recipient. Never
 * throws — returns a per-channel result array.
 */
async function notify(recipient, book, channelIds) {
  const wanted = channelIds && channelIds.length ? channelIds : channels.map((c) => c.id);
  const results = [];
  for (const c of channels) {
    if (!wanted.includes(c.id)) continue;
    if (!c.isConfigured()) {
      results.push({ channel: c.id, ok: false, skipped: true, error: 'not configured' });
      continue;
    }
    if (!c.supports(recipient)) {
      results.push({ channel: c.id, ok: false, skipped: true, error: 'no address for this channel' });
      continue;
    }
    try {
      await c.send({ recipient, book });
      results.push({ channel: c.id, ok: true });
    } catch (err) {
      results.push({ channel: c.id, ok: false, error: err.message });
    }
  }
  return results;
}

/**
 * Send a one-off test email so the user can verify SMTP end-to-end from the
 * Settings panel. Uses the email channel directly. Throws if email isn't
 * configured or the send fails.
 */
async function sendTest(email) {
  const ch = byId('email');
  if (!ch || !ch.isConfigured()) {
    throw new Error('Email is not configured — set SMTP_* in .env.');
  }
  await ch.send({
    recipient: { email },
    book: {
      title: 'BookHunt test email',
      description: 'If you can read this, your SMTP settings are working. 🎉',
    },
  });
}

module.exports = { listChannels, byId, notify, sendTest };
