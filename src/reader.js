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

/**
 * PURE: the per-reader web app manifest. The token is baked into start_url so
 * an installed home-screen icon (Android/Chrome, which uses the manifest)
 * launches straight to THIS reader's shelf. Icons + manifest live under
 * /reader/* so they clear Cloudflare Access like the rest of the portal. iOS
 * doesn't use start_url — it captures the current URL on "Add to Home Screen"
 * — so the token rides along there for free.
 */
function buildManifest(token) {
  const q = token ? `?t=${encodeURIComponent(token)}` : '';
  return {
    name: 'BookHunt',
    short_name: 'BookHunt',
    description: 'Your BookHunt shelf — send books to your Kindle.',
    start_url: `/reader${q}`,
    scope: '/reader',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#f6f1e7',
    theme_color: '#1c2a56',
    icons: [
      { src: '/reader/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/reader/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/reader/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
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

// Per-reader send throttle: bounds what a leaked link can do to its own
// owner's Kindle (the only thing it CAN do). Generous for a human picking
// books, hostile to a script. In-memory — resets on restart, which is fine
// for an abuse bound.
const SEND_LIMIT = Number(process.env.READER_SEND_LIMIT) || 15;
const SEND_WINDOW_MS = Number(process.env.READER_SEND_WINDOW_MS) || 3600000; // per hour
const _sendLog = new Map(); // recipientId -> [timestamps]

/** PURE-ish (injectable now): record + check one send against the throttle. */
function sendAllowed(recipientId, now = Date.now(), log = _sendLog) {
  const cutoff = now - SEND_WINDOW_MS;
  const times = (log.get(recipientId) || []).filter((t) => t > cutoff);
  if (times.length >= SEND_LIMIT) { log.set(recipientId, times); return false; }
  times.push(now);
  log.set(recipientId, times);
  return true;
}

/**
 * Push one book to the reader's own Kindle. The download entry is resolved
 * server-side from the id (never a client path), must be a VERIFIED download
 * living inside DOWNLOAD_PATH, and the destination is ALWAYS the recipient's
 * stored Kindle address — the token cannot aim a send anywhere else.
 */
async function sendToReader(recipient, downloadId) {
  const downloader = require('./downloader'); // lazy: avoids cycle via watcher
  if (!recipient.kindleEmail) {
    throw Object.assign(new Error('No Kindle address is saved for you yet — ask Eric to add it.'), { code: 'no-kindle' });
  }
  if (!sendAllowed(recipient.id)) {
    throw Object.assign(new Error('That’s a lot of books at once! Give it an hour and try again.'), { code: 'throttled' });
  }
  const entry = history.readAll().find((e) => e.id === downloadId && e.type === 'download');
  if (!entry || !entry.savePath || !entry.verified) {
    throw Object.assign(new Error('That book is no longer available.'), { code: 'gone' });
  }
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
// These share the app's email design language (see src/notify/email.js): a
// warm cream backdrop, a white rounded card, a navy header band carrying the
// 🔎 BookHunt wordmark, orange accents, and the "Sent with ♥ by Eric" footer.
// Email-client-safe: tables + inline styles only (no fl/grid, no <style>).
// Written plainly for non-technical readers — no jargon, no "token"/"login".

// Brand palette (inline; email clients ignore :root/vars).
const ACCENT = '#f1592a';
const NAVY = '#1c2a56';
const INK = '#1c2a56';
const MUTED = '#6b727e';
const PAPER = '#f6f1e7';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** The BookHunt card shell: header band + body + footer, matching the notify
 *  email. `body` is the inner rows HTML; `footerNote` is optional small print
 *  (e.g. the unsubscribe line) shown above the standard signature. */
function emailShell(subHeader, body, footerNote = '') {
  return `
  <div style="margin:0;padding:24px 12px;background:${PAPER};
              font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      <tr><td align="center">
        <table role="presentation" width="540" cellpadding="0" cellspacing="0"
               style="width:540px;max-width:540px;background:#ffffff;border-radius:16px;
                      overflow:hidden;box-shadow:0 4px 24px rgba(28,42,86,0.14)">

          <tr><td style="background:${NAVY};padding:16px 28px">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="font-size:20px;line-height:1;padding-right:9px">🔎</td>
              <td>
                <p style="margin:0;color:#ffffff;font-size:16px;font-weight:800;letter-spacing:0.2px">
                  Book<span style="color:${ACCENT}">Hunt</span>
                </p>
                <p style="margin:0;color:#aeb6d6;font-size:11px;font-weight:600">find books. find threads.</p>
              </td>
            </tr></table>
          </td></tr>

          <tr><td style="padding:18px 28px 0">
            <p style="margin:0;color:${ACCENT};font-size:13px;font-weight:700;letter-spacing:0.3px;text-transform:uppercase">
              ${subHeader}
            </p>
          </td></tr>

          ${body}

          <tr><td style="padding:16px 28px;background:#faf7f0;border-top:1px solid #ece5d6">
            ${footerNote ? `<p style="margin:0 0 6px;color:#9a93a1;font-size:11px">${footerNote}</p>` : ''}
            <p style="margin:0;color:#9a93a1;font-size:11px">Sent with ♥ by Eric via BookHunt</p>
          </td></tr>

        </table>
      </td></tr>
    </table>
  </div>`;
}

/** An orange call-to-action button row. */
function ctaRow(href, label, pad = '20px 28px 4px') {
  return `<tr><td style="padding:${pad}">
    <a href="${escapeHtml(href)}" style="display:inline-block;background:${ACCENT};color:#ffffff;
       text-decoration:none;font-size:15px;font-weight:700;padding:13px 26px;border-radius:10px">
      ${label}
    </a>
  </td></tr>`;
}

/** PURE: the invite email — warm, personal, one clear button. */
function buildInviteEmail(recipient) {
  const link = readerLink(recipient);
  const name = String(recipient.name || '').split(/\s+/)[0] || 'there';
  const body = `
    <tr><td style="padding:14px 28px 0">
      <p style="margin:0 0 10px;font-size:16px;color:${INK};line-height:1.6">Hi ${escapeHtml(name)},</p>
      <p style="margin:0;font-size:15px;color:${MUTED};line-height:1.65">
        Eric set up a personal book shelf just for you. Tap the button to see the newest books —
        and send any of them straight to your Kindle. No password, nothing to sign up for.
      </p>
    </td></tr>
    ${ctaRow(link, 'Open my shelf →', '22px 28px 6px')}
    <tr><td style="padding:8px 28px 22px">
      <div style="background:${PAPER};border-left:3px solid ${ACCENT};border-radius:8px;
                  padding:12px 15px;color:#3a3f47;font-size:13px;line-height:1.6">
        💡 Tip: this link is just for you — keep it handy and you can come back anytime.
        On your phone, you can even add it to your home screen like an app.
      </div>
    </td></tr>`;
  return {
    subject: `📖 Your BookHunt shelf is ready, ${name}`,
    text:
      `Hi ${name},\n\n` +
      `Eric set up a personal book shelf just for you. Open it to see the newest books and ` +
      `send any of them straight to your Kindle — no password, nothing to sign up for:\n\n${link}\n\n` +
      `This link is just for you — keep it handy and you can come back anytime.\n\n` +
      `Sent with love by Eric via BookHunt`,
    html: emailShell('Your shelf is ready', body),
    attachments: [],
  };
}

/** PURE: the "new books on the shelf" email — cover-forward book rows + CTA.
 *  Covers ride as inline CID images (cid:cover0@book …) so they render even
 *  when a client blocks remote images, matching the notify email. */
function buildNewBooksEmail(recipient, books) {
  const link = readerLink(recipient);
  const name = String(recipient.name || '').split(/\s+/)[0] || 'there';
  const n = books.length;

  const attachments = [];
  const rows = books.map((b, i) => {
    const hasCover = /^https?:\/\//i.test(String(b.cover || ''));
    let coverCell;
    if (hasCover) {
      const cid = `cover${i}@book`;
      attachments.push({ filename: `cover${i}.jpg`, path: b.cover, cid });
      coverCell = `<img src="cid:${cid}" alt="" width="54"
        style="width:54px;height:auto;display:block;border-radius:7px;box-shadow:0 3px 10px rgba(0,0,0,0.18)">`;
    } else {
      coverCell = `<div style="width:54px;height:80px;border-radius:7px;
        background:linear-gradient(135deg,${NAVY},#2a3a72);text-align:center;line-height:80px;font-size:24px">📖</div>`;
    }
    return `<tr>
      <td valign="top" width="54" style="padding:0 16px 16px 0">${coverCell}</td>
      <td valign="top" style="padding:0 0 16px">
        <p style="margin:0 0 3px;font-size:16px;font-weight:700;color:${INK};line-height:1.3">${escapeHtml(b.title)}</p>
        ${b.author ? `<p style="margin:0;font-size:14px;color:${MUTED}">${escapeHtml(b.author)}</p>` : ''}
      </td>
    </tr>`;
  }).join('');

  const body = `
    <tr><td style="padding:14px 28px 0">
      <p style="margin:0 0 4px;font-size:16px;color:${INK};line-height:1.6">Hi ${escapeHtml(name)},</p>
      <p style="margin:0;font-size:15px;color:${MUTED};line-height:1.6">
        ${n === 1 ? 'A new book just landed on your shelf:' : `${n} new books just landed on your shelf:`}
      </p>
    </td></tr>
    <tr><td style="padding:18px 28px 0">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rows}</table>
    </td></tr>
    ${ctaRow(link, 'Pick what to send to my Kindle →', '6px 28px 22px')}`;

  const footerNote =
    `Getting too many of these? <a href="${escapeHtml(link + '&unsub=1')}" style="color:#9a93a1">Stop these emails</a> ` +
    `— your shelf still works anytime.`;

  return {
    subject: n === 1 ? `📚 A new book is on your shelf` : `📚 ${n} new books are on your shelf`,
    text:
      `Hi ${name},\n\n` +
      `${n === 1 ? 'A new book just landed on your shelf:' : `${n} new books just landed on your shelf:`}\n` +
      `${books.map((b) => `  • ${b.title}${b.author ? ' — ' + b.author : ''}`).join('\n')}\n\n` +
      `Pick what you'd like sent to your Kindle:\n${link}\n\n` +
      `Sent with love by Eric via BookHunt`,
    html: emailShell(n === 1 ? 'A new book for you' : 'New books for you', body, footerNote),
    attachments,
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
  buildManifest,
  booksForReader,
  sendToReader,
  invite,
  notifyNewBooks,
  // exported for unit tests
  recentBooks,
  sentTo,
  sendAllowed,
  buildNewBooksEmail,
  buildInviteEmail,
  newToken,
};
