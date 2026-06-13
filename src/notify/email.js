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
 * book: { title, author, cover, sourceUrl, format, size, filename, pushedToKindle }
 */
async function send({ recipient, book }) {
  const title = book.title || book.filename || 'a new book';
  const author = book.author ? ` by ${book.author}` : '';
  const where = book.pushedToKindle ? 'It’s been sent to your Kindle.' : '';

  const bits = [];
  if (book.format) bits.push(`Format: ${esc(book.format)}`);
  if (book.size) bits.push(`Size: ${esc(book.size)}`);
  const meta = bits.length ? `<p style="color:#666;font-size:13px;margin:6px 0">${bits.join(' &middot; ')}</p>` : '';
  const src = book.sourceUrl
    ? `<p style="font-size:13px;margin:6px 0"><a href="${esc(book.sourceUrl)}">View source thread</a></p>`
    : '';

  // Attach the cover as an inline CID image so it renders even when clients
  // block remote images. nodemailer fetches the http(s) `path` itself.
  const attachments = [];
  let coverHtml = '';
  if (book.cover) {
    attachments.push({ filename: 'cover.jpg', path: book.cover, cid: 'cover@book' });
    coverHtml = `<img src="cid:cover@book" alt="cover" style="max-width:180px;border-radius:6px;display:block;margin:10px 0">`;
  }

  const html = `
    <div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:520px">
      <p style="font-size:16px;margin:0 0 4px">📚 <strong>${esc(title)}</strong>${esc(author)}</p>
      ${coverHtml}
      <p style="margin:6px 0">A new book was added for you.${where ? ' ' + esc(where) : ''}</p>
      ${meta}
      ${src}
      <p style="color:#999;font-size:12px;margin-top:16px">Sent by Mobilism Finder</p>
    </div>`;

  const text =
    `📚 ${title}${author}\n\nA new book was added for you.` +
    (where ? ` ${where}` : '') +
    (book.sourceUrl ? `\n\nSource: ${book.sourceUrl}` : '');

  await smtp.getTransport().sendMail({
    from: smtp.FROM,
    to: recipient.email,
    subject: `📚 ${title}${author}`,
    text,
    html,
    attachments,
  });
}

module.exports = { id, label, isConfigured, supports, send };
