'use strict';

// Email notification channel. Sends a recipient a warm, visually-designed
// announcement that a new book has arrived — cover, title, author, and blurb —
// laid out with email-client-safe tables + inline styles (no fl/grid, no <style>
// block, which many clients strip). This is the message a PERSON reads (unlike
// the silent @kindle.com push).

const smtp = require('../smtp');

const id = 'email';
const label = 'Email';

// BookHunt brand palette (kept inline; email clients ignore :root/vars).
const ACCENT = '#f1592a'; // hot orange — the magnifying glass
const NAVY = '#1c2a56';   // deep navy — the book / header band
const INK = '#1c2a56';
const MUTED = '#6b727e';
const PAPER = '#f6f1e7';  // warm cream

function isConfigured() {
  return smtp.isConfigured();
}

// Needs a real inbox address to notify.
function supports(recipient) {
  return !!(recipient && recipient.email);
}

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  );
}

// The cover cell: a real cover (inline CID image) when we have one, otherwise a
// tasteful gradient placeholder so the layout never collapses.
function coverCell(hasCover) {
  if (hasCover) {
    return `<img src="cid:cover@book" alt="Book cover" width="120"
      style="width:120px;height:auto;display:block;border-radius:10px;
             box-shadow:0 6px 18px rgba(0,0,0,0.22)">`;
  }
  return `<div style="width:120px;height:180px;border-radius:10px;
      background:linear-gradient(135deg,${NAVY},#2a3a72);
      box-shadow:0 6px 18px rgba(0,0,0,0.22);text-align:center;line-height:180px;
      font-size:44px">📖</div>`;
}

/**
 * PURE: build the email message ({ subject, text, html, attachments }) for a
 * recipient + book. Exported so the design can be previewed and unit-tested
 * without an SMTP transport.
 *
 * book: { title, author, cover, description, filename, pushedToKindle }
 */
function buildMessage({ recipient, book }) {
  const title = book.title || book.filename || 'a new book';
  const author = book.author ? `by ${book.author}` : '';
  const name = recipient && recipient.name ? String(recipient.name).split(/\s+/)[0] : '';
  const greeting = name ? `Hi ${esc(name)},` : 'Hi there,';

  // A watchlist hit (issue #7) reads differently from a hand-picked send: it's
  // "the book you asked us to watch just showed up — go grab it".
  const isWatch = !!book.watch;
  const link = /^https?:\/\//i.test(String(book.link || '')) ? String(book.link) : '';

  const subHeader = isWatch ? 'A book you’re watching is available' : 'A new book just landed';
  const intro = isWatch
    ? 'Good news — a book on your watchlist just turned up on Mobilism:'
    : 'Eric just sent you something new to read:';
  const pill = isWatch ? '🔔 Back in stock' : '✨ New arrival';

  // Tailor the closing line to what actually happened.
  const delivery = isWatch
    ? `Head over and grab it while it’s live. Happy hunting! 🔎`
    : book.pushedToKindle
      ? `It’s already on its way to your Kindle — it’ll show up in your library in a minute or two. Happy reading! 🎉`
      : `It’s ready and waiting for you. Happy reading! 🎉`;

  // Optional call-to-action button (the Mobilism thread) — shown when a link is
  // supplied (watch hits always carry one; sends currently don't).
  const cta = link
    ? `<tr><td style="padding:4px 28px 0">
         <a href="${esc(link)}" style="display:inline-block;background:${ACCENT};color:#ffffff;
            text-decoration:none;font-size:14px;font-weight:700;padding:11px 20px;border-radius:9px">
           Open on Mobilism →
         </a>
       </td></tr>`
    : '';

  // Attach the cover as an inline CID image so it renders even when clients
  // block remote images. nodemailer fetches the http(s) `path` itself. Only do
  // this for real http(s) URLs (skip data URIs / blanks).
  const attachments = [];
  const hasCover = /^https?:\/\//i.test(String(book.cover || ''));
  if (hasCover) {
    attachments.push({ filename: 'cover.jpg', path: book.cover, cid: 'cover@book' });
  }

  const blurb = book.description
    ? `<tr><td style="padding:20px 28px 4px">
         <div style="background:${PAPER};border-left:3px solid ${ACCENT};border-radius:8px;
                     padding:14px 16px;color:#3a3f47;font-size:14px;line-height:1.65">
           ${esc(book.description)}
         </div>
       </td></tr>`
    : '';

  const html = `
  <div style="margin:0;padding:24px 12px;background:${PAPER};
              font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      <tr><td align="center">
        <table role="presentation" width="540" cellpadding="0" cellspacing="0"
               style="width:540px;max-width:540px;background:#ffffff;border-radius:16px;
                      overflow:hidden;box-shadow:0 4px 24px rgba(28,42,86,0.14)">

          <!-- Header band -->
          <tr><td style="background:${NAVY};padding:16px 28px">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="font-size:20px;line-height:1;padding-right:9px">🔎</td>
              <td>
                <p style="margin:0;color:#ffffff;font-size:16px;font-weight:800;letter-spacing:0.2px">
                  Book<span style="color:${ACCENT}">Hunt</span>
                </p>
                <p style="margin:0;color:#aeb6d6;font-size:11px;font-weight:600">find your book.</p>
              </td>
            </tr></table>
          </td></tr>

          <!-- Sub-header -->
          <tr><td style="padding:18px 28px 0">
            <p style="margin:0;color:${ACCENT};font-size:13px;font-weight:700;letter-spacing:0.3px;text-transform:uppercase">
              ${subHeader}
            </p>
          </td></tr>

          <!-- Greeting -->
          <tr><td style="padding:12px 28px 0">
            <p style="margin:0 0 4px;font-size:15px;color:${MUTED}">${greeting}</p>
            <p style="margin:0;font-size:15px;color:${MUTED}">${intro}</p>
          </td></tr>

          <!-- Cover + title/author -->
          <tr><td style="padding:18px 28px 0">
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
              <tr>
                <td valign="top" width="120" style="padding-right:20px">
                  ${coverCell(hasCover)}
                </td>
                <td valign="top">
                  <p style="margin:0 0 6px;font-size:22px;font-weight:800;color:${INK};line-height:1.25">
                    ${esc(title)}
                  </p>
                  ${author ? `<p style="margin:0 0 12px;font-size:15px;color:${MUTED}">${esc(author)}</p>` : ''}
                  <span style="display:inline-block;background:#fde8df;color:${ACCENT};
                               font-size:12px;font-weight:700;padding:5px 12px;border-radius:999px">
                    ${pill}
                  </span>
                </td>
              </tr>
            </table>
          </td></tr>

          <!-- Blurb -->
          ${blurb}

          <!-- Call to action -->
          ${cta}

          <!-- Delivery line -->
          <tr><td style="padding:20px 28px 24px">
            <p style="margin:0;font-size:15px;color:${INK};line-height:1.6">${delivery}</p>
          </td></tr>

          <!-- Footer -->
          <tr><td style="padding:16px 28px;background:#faf7f0;border-top:1px solid #ece5d6">
            <p style="margin:0;color:#9a93a1;font-size:11px">Sent with ♥ by Eric via BookHunt</p>
          </td></tr>

        </table>
      </td></tr>
    </table>
  </div>`;

  const text =
    `${name ? 'Hi ' + name + ',' : 'Hi there,'}\n\n` +
    `${isWatch ? 'A book on your watchlist just turned up on Mobilism:' : 'Eric just sent you a new book to read:'}\n\n` +
    `${title}${author ? ' ' + author : ''}` +
    (book.description ? `\n\n${book.description}` : '') +
    (link ? `\n\nOpen on Mobilism: ${link}` : '') +
    `\n\n${
      isWatch
        ? 'Head over and grab it while it’s live. Happy hunting!'
        : (book.pushedToKindle ? "It's on its way to your Kindle now." : "It's ready and waiting for you.") + ' Happy reading!'
    }`;

  return {
    subject: isWatch
      ? `🔔 A book you’re watching is available: “${title}”`
      : `📚 A new book for you: “${title}”`,
    text,
    html,
    attachments,
  };
}

async function send({ recipient, book }) {
  const msg = buildMessage({ recipient, book });
  await smtp.getTransport().sendMail({ from: smtp.FROM, to: recipient.email, ...msg });
}

module.exports = { id, label, isConfigured, supports, send, buildMessage };
