'use strict';

// Reader-portal emails: the invite, the "new books for you" digest and feature
// announcements. Built on the shared kit (src/notify/emailkit.js) and written
// plainly for non-technical readers — no jargon, no "token"/"login". PURE:
// every builder takes its data and returns { subject, text, html, attachments }.

const { ACCENT, NAVY, INK, MUTED, PAPER, escapeHtml, emailShell, ctaRow } = require('./notify/emailkit');

const BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://bookhunt.mooseflip.com').replace(/\/+$/, '');

function readerLink(recipient) {
  return `${BASE_URL}/reader?t=${encodeURIComponent(recipient.readerToken || '')}`;
}

/** PURE: the invite email — warm, personal, one clear button. */
function buildInviteEmail(recipient) {
  const link = readerLink(recipient);
  const name = String(recipient.name || '').split(/\s+/)[0] || 'there';
  const body = `
    <tr><td style="padding:14px 28px 0">
      <p style="margin:0 0 10px;font-size:16px;color:${INK};line-height:1.6">Hi ${escapeHtml(name)},</p>
      <p style="margin:0;font-size:15px;color:${MUTED};line-height:1.65">
        Eric set up a personal BookHunt Library just for you. Tap the button to see the newest books —
        and send any of them straight to your Kindle. No password, nothing to sign up for.
      </p>
    </td></tr>
    ${ctaRow(link, 'Open my Library →', '22px 28px 6px')}
    <tr><td style="padding:8px 28px 22px">
      <div style="background:${PAPER};border-left:3px solid ${ACCENT};border-radius:8px;
                  padding:12px 15px;color:#3a3f47;font-size:13px;line-height:1.6">
        💡 Tip: this link is just for you — keep it handy and you can come back anytime.
        On your phone, you can even add it to your home screen like an app.
      </div>
    </td></tr>`;
  return {
    subject: `📖 Your BookHunt Library is ready, ${name}`,
    text:
      `Hi ${name},\n\n` +
      `Eric set up a personal BookHunt Library just for you. Open it to see the newest books and ` +
      `send any of them straight to your Kindle — no password, nothing to sign up for:\n\n${link}\n\n` +
      `This link is just for you — keep it handy and you can come back anytime.\n\n` +
      `Sent with love by Eric via BookHunt`,
    html: emailShell('Your Library is ready', body),
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
        ${n === 1 ? 'A new book just arrived in your Library:' : `${n} new books just arrived in your Library:`}
      </p>
    </td></tr>
    <tr><td style="padding:18px 28px 0">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rows}</table>
    </td></tr>
    ${ctaRow(link, 'Pick what to send to my Kindle →', '6px 28px 22px')}`;

  const footerNote =
    `Getting too many of these? <a href="${escapeHtml(link + '&unsub=1')}" style="color:#9a93a1">Stop these emails</a> ` +
    `— your Library still works anytime.`;

  return {
    subject: n === 1 ? `📚 A new book is in your Library` : `📚 ${n} new books are in your Library`,
    text:
      `Hi ${name},\n\n` +
      `${n === 1 ? 'A new book just arrived in your Library:' : `${n} new books just arrived in your Library:`}\n` +
      `${books.map((b) => `  • ${b.title}${b.author ? ' — ' + b.author : ''}`).join('\n')}\n\n` +
      `Pick what you'd like sent to your Kindle:\n${link}\n\n` +
      `Sent with love by Eric via BookHunt`,
    html: emailShell(n === 1 ? 'A new book for you' : 'New books for you', body, footerNote),
    attachments,
  };
}

// --- feature announcements ------------------------------------------------------
// One-off "what's new" emails to readers. Each announcement has a stable id;
// a recipient is stamped (`readerAnnouncements[id]`) right after their send so
// re-running never double-emails anyone. Readers who unsubscribed
// (readerEnabled === false) are skipped — this is still a reader email.

const BOOK_DETAILS_ANNOUNCEMENT = 'book-details-2026-10';

/** PURE: trim a catalog blurb to a teaser that ends on a word, with an ellipsis. */
function teaser(text, max = 220) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s.,;:—-]+$/, '') + '…';
}

/** PURE: the "tap a book to peek inside" announcement email. `sample` is an
 *  optional real shelf book `{ title, author, cover, description }` rendered
 *  as a mini version of the new details card, so the reader sees exactly what
 *  they'll get; without one, a generic illustrated card stands in. Covers ride
 *  as an inline CID image (like the new-books email). */
function buildBookDetailsAnnouncement(recipient, sample = null) {
  const link = readerLink(recipient);
  const name = String(recipient.name || '').split(/\s+/)[0] || 'there';
  const attachments = [];

  const s = sample && sample.title ? sample : null;
  let coverCell = `<div style="width:96px;height:144px;border-radius:9px;
      background:linear-gradient(135deg,${NAVY},#2a3a72);text-align:center;line-height:144px;font-size:40px">📖</div>`;
  if (s && /^https?:\/\//i.test(String(s.cover || ''))) {
    attachments.push({ filename: 'cover.jpg', path: s.cover, cid: 'feature-cover@book' });
    coverCell = `<img src="cid:feature-cover@book" alt="" width="96"
      style="width:96px;height:auto;display:block;border-radius:9px;box-shadow:0 6px 18px rgba(0,0,0,0.25)">`;
  }
  const cardTitle = s ? escapeHtml(s.title) : 'Your next great read';
  const cardAuthor = s ? (s.author ? 'by ' + escapeHtml(s.author) : '') : 'by a favorite author';
  const cardDesc = s && s.description
    ? escapeHtml(teaser(s.description))
    : 'A bigger look at the cover, plus what the book is about — so you can decide if it’s the one before you send it.';

  // A little mock of the new modal: dimmed "shelf" behind, a white card in
  // front with the ✕, a big cover, the blurb and the orange Send button.
  const mock = `
    <tr><td style="padding:18px 28px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="background:#2b3150;border-radius:14px">
        <tr><td style="padding:18px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                 style="background:#ffffff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,0.35)">
            <tr><td align="right" style="padding:10px 12px 0">
              <span style="display:inline-block;width:26px;height:26px;line-height:26px;text-align:center;
                           border-radius:13px;background:${PAPER};color:${INK};font-size:13px">✕</span>
            </td></tr>
            <tr><td style="padding:0 18px 18px">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
                <td valign="top" width="96" style="padding:0 16px 0 0">${coverCell}</td>
                <td valign="top">
                  <p style="margin:0 0 3px;font-size:16px;font-weight:800;color:${INK};line-height:1.3">${cardTitle}</p>
                  ${cardAuthor ? `<p style="margin:0 0 8px;font-size:13px;color:${MUTED}">${cardAuthor}</p>` : ''}
                  <p style="margin:0 0 12px;font-size:13px;color:#3a3f47;line-height:1.55">${cardDesc}</p>
                  <span style="display:inline-block;background:${ACCENT};color:#ffffff;font-size:12px;font-weight:700;
                               padding:8px 12px;border-radius:8px">📤 Send to my Kindle</span>
                </td>
              </tr></table>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </td></tr>`;

  const steps = [
    ['👆', 'Tap or click any book in your Library.'],
    ['📖', 'See a bigger cover and what the story is about.'],
    ['📤', 'Like it? Send it to your Kindle right from there.'],
  ].map(([icon, txt]) => `<tr>
      <td valign="top" width="30" style="padding:0 10px 10px 0;font-size:18px;line-height:1.4">${icon}</td>
      <td valign="top" style="padding:0 0 10px;font-size:15px;color:${INK};line-height:1.5">${txt}</td>
    </tr>`).join('');

  const body = `
    <tr><td style="padding:14px 28px 0">
      <p style="margin:0 0 10px;font-size:16px;color:${INK};line-height:1.6">Hi ${escapeHtml(name)},</p>
      <p style="margin:0;font-size:15px;color:${MUTED};line-height:1.65">
        Your BookHunt Library just got a little better. Not sure what a book is about?
        Now you can <b style="color:${INK}">tap it to take a closer look</b> before you send it.
      </p>
    </td></tr>
    ${mock}
    <tr><td style="padding:20px 28px 0">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${steps}</table>
    </td></tr>
    ${ctaRow(link, 'Try it in my Library →', '10px 28px 6px')}
    <tr><td style="padding:8px 28px 22px">
      <div style="background:${PAPER};border-left:3px solid ${ACCENT};border-radius:8px;
                  padding:12px 15px;color:#3a3f47;font-size:13px;line-height:1.6">
        💡 To close it, tap the ✕ or anywhere outside the book — you’re right back in your Library.
      </div>
    </td></tr>`;

  const footerNote =
    `Rather not get BookHunt emails? <a href="${escapeHtml(link + '&unsub=1')}" style="color:#9a93a1">Stop these emails</a> ` +
    `— your Library still works anytime.`;

  return {
    subject: `✨ New in your Library: tap a book to peek inside`,
    text:
      `Hi ${name},\n\n` +
      `Your BookHunt Library just got a little better. Not sure what a book is about? ` +
      `Now you can tap it to take a closer look before you send it:\n\n` +
      `  1. Tap or click any book in your Library.\n` +
      `  2. See a bigger cover and what the story is about.\n` +
      `  3. Like it? Send it to your Kindle right from there.\n\n` +
      `Try it out:\n${link}\n\n` +
      `To close it, tap the X or anywhere outside the card.\n\n` +
      `Sent with love by Eric via BookHunt`,
    html: emailShell('New in your Library', body, footerNote),
    attachments,
  };
}

module.exports = {
  BASE_URL,
  readerLink,
  buildInviteEmail,
  buildNewBooksEmail,
  buildBookDetailsAnnouncement,
  BOOK_DETAILS_ANNOUNCEMENT,
  teaser,
};
