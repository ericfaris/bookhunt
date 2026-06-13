'use strict';

// Email notification channel. Sends a recipient a short, human-readable note
// about a newly added book, with the cover shown inline. This is the message a
// PERSON reads (unlike the silent @kindle.com push).

const smtp = require('../smtp');

const id = 'email';
const label = 'Email';

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

/**
 * book: { title, author, cover, description, filename, pushedToKindle }
 */
async function send({ recipient, book }) {
  const title = book.title || book.filename || 'a new book';
  const author = book.author ? ` by ${book.author}` : '';

  const descHtml = book.description
    ? `<p style="margin:10px 0 0;line-height:1.6;color:#444;font-size:14px">${esc(book.description)}</p>`
    : '';

  // Attach the cover as an inline CID image so it renders even when clients
  // block remote images. nodemailer fetches the http(s) `path` itself.
  const attachments = [];
  let coverHtml = '';
  if (book.cover) {
    attachments.push({ filename: 'cover.jpg', path: book.cover, cid: 'cover@book' });
    coverHtml = `<img src="cid:cover@book" alt="cover" style="max-width:160px;border-radius:6px;display:block;margin:12px 0">`;
  }

  const html = `
    <div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:520px">
      <p style="font-size:17px;margin:0 0 16px;font-weight:600">Eric has sent a new book to your Kindle! 📚</p>
      ${coverHtml}
      <p style="font-size:16px;margin:0 0 2px"><strong>${esc(title)}</strong></p>
      ${book.author ? `<p style="margin:0;color:#555;font-size:14px">${esc(book.author)}</p>` : ''}
      ${descHtml}
      <p style="color:#bbb;font-size:11px;margin-top:24px;border-top:1px solid #eee;padding-top:10px">Sent by Eric via Mobilism Finder</p>
    </div>`;

  const text =
    `Eric has sent a new book to your Kindle!\n\n${title}${author}` +
    (book.description ? `\n\n${book.description}` : '');

  await smtp.getTransport().sendMail({
    from: smtp.FROM,
    to: recipient.email,
    subject: `📚 ${title} — Eric sent it to your Kindle!`,
    text,
    html,
    attachments,
  });
}

module.exports = { id, label, isConfigured, supports, send };
