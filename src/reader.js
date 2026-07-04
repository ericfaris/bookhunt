'use strict';

// Reader portal (issue #34): passwordless, invite-only magic links that let a
// recipient browse recently shelved books and push the ones they want to their
// OWN Kindle — taking the operator out of the send loop.
//
// Identity is a per-recipient 32-byte token carried in the link
// (/reader?t=...). The token's entire authority is: view recent titles/covers,
// send to that recipient's stored Kindle address, and unsubscribe themselves —
// no downloads, no settings, no other readers. A leaked link is low-stakes and
// revocable (rotate = new token, old link dies).
//
// /reader/* bypasses Cloudflare Access at the edge (path-scoped bypass app —
// manual dashboard step, see README) and is instead guarded here: token
// lookup is constant-time over sha256 digests, bad tokens 404 (no oracle),
// and the routes ride a tight rate limit in server.js.

const crypto = require('crypto');
const path = require('path');

const recipients = require('./recipients');
const history = require('./history');
const library = require('./library');
const booktags = require('./booktags');
const covers = require('./covers');
const kindle = require('./kindle');
const smtp = require('./smtp');

// Public origin for links in reader emails (the app itself never needs this —
// only mail does, since a reader's email client can't use relative URLs).
const BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://bookhunt.mooseflip.com').replace(/\/+$/, '');

// How far back the picker looks. New releases churn weekly; a month of depth
// keeps the page cozy instead of overwhelming.
const RECENT_DAYS = Number(process.env.READER_RECENT_DAYS) || 30;

// At most one "new books" email per reader per this window, however often the
// notifier is invoked — the notifier itself is fired opportunistically.
const NOTIFY_MIN_GAP_MS = Number(process.env.READER_NOTIFY_GAP_MS) || 20 * 3600 * 1000;

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function readerLink(recipient) {
  return `${BASE_URL}/reader?t=${encodeURIComponent(recipient.readerToken || '')}`;
}

/** Ensure a recipient has a reader token (lazily minted, persisted). */
function ensureToken(id) {
  const list = recipients.readAll();
  const r = list.find((x) => x.id === id);
  if (!r) return null;
  if (!r.readerToken) {
    r.readerToken = newToken();
    if (r.readerEnabled === undefined) r.readerEnabled = true;
    recipients.writeAll(list);
  }
  return r;
}

/** Rotate a recipient's token — the old magic link stops working immediately. */
function rotateToken(id) {
  const list = recipients.readAll();
  const r = list.find((x) => x.id === id);
  if (!r) return null;
  r.readerToken = newToken();
  recipients.writeAll(list);
  return r;
}

function setReaderEnabled(id, enabled) {
  const list = recipients.readAll();
  const r = list.find((x) => x.id === id);
  if (!r) return null;
  r.readerEnabled = !!enabled;
  recipients.writeAll(list);
  return r;
}

/**
 * Resolve a presented token to its recipient, or null. Constant-time: every
 * stored token is compared (as a sha256 digest) whether or not an earlier one
 * matched, so response timing doesn't leak which tokens exist.
 */
function byToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const presented = crypto.createHash('sha256').update(token).digest();
  let match = null;
  for (const r of recipients.readAll()) {
    // readerEnabled gates EMAILS only (unsubscribe shouldn't brick the shelf
    // link a reader may have bookmarked); the token alone grants page access.
    if (!r.readerToken) continue;
    const stored = crypto.createHash('sha256').update(r.readerToken).digest();
    if (crypto.timingSafeEqual(presented, stored)) match = r;
  }
  return match;
}

// --- books for the picker ------------------------------------------------------

function buildBooks() {
  return library.buildLibrary(history.readAll(), (p) => booktags.readStore()[booktags.keyFor(p)] || []);
}

/** PURE-ish core: which books surface to readers — verified, still on disk,
 *  added within the window. Newest first (buildLibrary's order). */
function recentBooks(books, now = Date.now(), days = RECENT_DAYS) {
  const cutoff = now - days * 24 * 3600 * 1000;
  return (books || []).filter((b) => {
    if (!b.verified || !b.filePresent) return false;
    const at = Date.parse(b.acquiredAt || '');
    return !Number.isNaN(at) && at >= cutoff;
  });
}

/** PURE: has this book already been sent to this recipient? Sends log `to` as
 *  an array of recipient NAMES (the app's existing convention). */
function sentTo(book, recipient) {
  const name = (recipient.name || '').toLowerCase();
  return (book.sends || []).some((s) =>
    (Array.isArray(s.to) ? s.to : [s.to]).some((t) => String(t || '').toLowerCase() === name)
  );
}

/** The picker payload for one reader: safe fields only. Covers resolve through
 *  the disk-cached catalog lookup (each book at most once, ever). */
async function booksForReader(recipient) {
  const recent = recentBooks(buildBooks());
  const out = [];
  for (const b of recent) {
    let cover = b.cover || null;
    if (!cover) {
      try { cover = await covers.resolveCover({ title: b.title, author: b.author }); } catch { /* placeholder */ }
    }
    out.push({
      id: b.id,
      title: b.title || b.filename || 'Untitled',
      author: b.author || '',
      cover,
      acquiredAt: b.acquiredAt,
      tags: b.tags || [],
      sent: sentTo(b, recipient),
    });
  }
  return out;
}

// --- sending ---------------------------------------------------------------------

/**
 * Push one book to the reader's own Kindle. The download entry is resolved
 * server-side from the id (never a client path), must live inside
 * DOWNLOAD_PATH, and the destination is ALWAYS the recipient's stored Kindle
 * address — the token cannot aim a send anywhere else.
 */
async function sendToReader(recipient, downloadId) {
  const downloader = require('./downloader'); // lazy: avoids cycle via watcher
  if (!recipient.kindleEmail) {
    throw Object.assign(new Error('No Kindle address is saved for you yet — ask Eric to add it.'), { code: 'no-kindle' });
  }
  const entry = history.readAll().find((e) => e.id === downloadId && e.type === 'download');
  if (!entry || !entry.savePath) throw Object.assign(new Error('That book is no longer available.'), { code: 'gone' });
  if (!downloader.isSafeEpubPath(entry.savePath, downloader.DOWNLOAD_PATH)) {
    throw Object.assign(new Error('That book is no longer available.'), { code: 'gone' });
  }
  await kindle.pushToKindle({
    kindleEmail: recipient.kindleEmail,
    filePath: path.resolve(entry.savePath),
    filename: entry.filename,
  });
  history.logNotify({
    downloadId,
    title: entry.title,
    filename: entry.filename,
    to: [recipient.name],
    kindlePushed: true,
    channels: [{ channel: 'reader', ok: true }],
  });
  return { title: entry.title, kindleEmail: recipient.kindleEmail };
}

// --- reader emails -----------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** PURE: the "new books on the shelf" email for one reader. */
function buildNewBooksEmail(recipient, books) {
  const link = readerLink(recipient);
  const n = books.length;
  const subject = `📚 ${n} new book${n === 1 ? '' : 's'} on the BookHunt shelf`;
  const text =
    `Hi ${recipient.name},\n\n` +
    `New on the shelf:\n${books.map((b) => `  • ${b.title}${b.author ? ' — ' + b.author : ''}`).join('\n')}\n\n` +
    `Pick what you'd like sent to your Kindle:\n${link}\n\n` +
    `(This link is yours alone — no login needed.)`;
  const rows = books.map((b) =>
    `<tr><td style="padding:6px 12px 6px 0">${b.cover ? `<img src="${escapeHtml(b.cover)}" width="46" style="border-radius:4px" alt="">` : '📕'}</td>` +
    `<td><strong>${escapeHtml(b.title)}</strong>${b.author ? `<br><span style="color:#666">${escapeHtml(b.author)}</span>` : ''}</td></tr>`
  ).join('');
  const html =
    `<div style="font-family:sans-serif;max-width:560px">` +
    `<h2 style="margin:0 0 12px">New books on the shelf 📚</h2>` +
    `<p>Hi ${escapeHtml(recipient.name)} — fresh arrivals you can send to your Kindle:</p>` +
    `<table style="border-collapse:collapse">${rows}</table>` +
    `<p style="margin:18px 0"><a href="${escapeHtml(link)}" style="background:#e4572e;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Browse &amp; send to my Kindle</a></p>` +
    `<p style="color:#888;font-size:12px">This link is yours alone — no login needed. ` +
    `<a href="${escapeHtml(link + '&unsub=1')}" style="color:#888">Stop these emails</a>.</p></div>`;
  return { subject, text, html };
}

/** PURE: the invite email. */
function buildInviteEmail(recipient) {
  const link = readerLink(recipient);
  return {
    subject: `📖 You're invited to the BookHunt shelf`,
    text:
      `Hi ${recipient.name},\n\nEric set you up with a personal book shelf. ` +
      `Open your link to browse new books and send any of them straight to your Kindle — no login needed:\n\n${link}\n\n` +
      `Keep the link to yourself; it's your key.`,
    html:
      `<div style="font-family:sans-serif;max-width:560px">` +
      `<h2 style="margin:0 0 12px">Your BookHunt shelf 📖</h2>` +
      `<p>Hi ${escapeHtml(recipient.name)} — Eric set you up with a personal shelf. Browse new books and send any of them straight to your Kindle. No login, no password — the link below is your key, so keep it to yourself.</p>` +
      `<p style="margin:18px 0"><a href="${escapeHtml(link)}" style="background:#e4572e;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Open my shelf</a></p></div>`,
  };
}

/** Email the invite (mints the token if needed). */
async function invite(id) {
  const r = ensureToken(id);
  if (!r) throw new Error('Recipient not found');
  if (!r.email) throw new Error('Recipient has no email address');
  if (!smtp.isConfigured()) throw new Error('SMTP is not configured');
  setReaderEnabled(id, true); // an invite (re-)opts them into new-book emails
  const msg = buildInviteEmail(r);
  await smtp.getTransport().sendMail({ from: smtp.FROM, to: r.email, ...msg });
  return r;
}

/**
 * Opportunistic notifier: for each enabled reader, email the books shelved
 * since their last reader email (first email looks back RECENT_DAYS). Self-
 * throttled per reader, so callers can fire it as often as they like. Never
 * throws; returns how many emails went out.
 */
async function notifyNewBooks() {
  if (!smtp.isConfigured()) return 0;
  const now = Date.now();
  const recent = recentBooks(buildBooks(), now);
  if (!recent.length) return 0;
  const list = recipients.readAll();
  let sentCount = 0;
  let dirty = false;
  for (const r of list) {
    if (!r.readerToken || r.readerEnabled === false || !r.email) continue;
    const last = Date.parse(r.readerNotifiedAt || '') || 0;
    if (now - last < NOTIFY_MIN_GAP_MS) continue;
    const fresh = recent.filter((b) => {
      const at = Date.parse(b.acquiredAt || '') || 0;
      return at > last;
    });
    if (!fresh.length) continue;
    try {
      const books = [];
      for (const b of fresh.slice(0, 12)) {
        let cover = b.cover || null;
        if (!cover) {
          try { cover = await covers.resolveCover({ title: b.title, author: b.author }); } catch { /* none */ }
        }
        books.push({ title: b.title || b.filename, author: b.author, cover });
      }
      const msg = buildNewBooksEmail(r, books);
      await smtp.getTransport().sendMail({ from: smtp.FROM, to: r.email, ...msg });
      r.readerNotifiedAt = new Date(now).toISOString();
      dirty = true;
      sentCount++;
    } catch (err) {
      console.warn('[reader] notify failed for %s: %s', r.email, err.message);
    }
  }
  if (dirty) recipients.writeAll(list);
  return sentCount;
}

module.exports = {
  BASE_URL,
  RECENT_DAYS,
  ensureToken,
  rotateToken,
  setReaderEnabled,
  byToken,
  readerLink,
  booksForReader,
  sendToReader,
  invite,
  notifyNewBooks,
  // exported for unit tests
  recentBooks,
  sentTo,
  buildNewBooksEmail,
  buildInviteEmail,
  newToken,
};
