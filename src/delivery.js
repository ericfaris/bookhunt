'use strict';

// The pieces every "send a book to people" path shares — the operator's Send
// (/api/send), the watcher's auto-delivery, and a reader's own send. Each path
// keeps its own policy (who gets emailed, what's logged, how errors surface);
// this module owns the mechanics they used to copy-paste:
//   - fetch the book's Kindle attachment at most once per send, whatever the
//     storage backend (local path or R2 bytes);
//   - push it to one recipient's Kindle with a uniform outcome;
//   - fill a book's missing cover/blurb and attach the stored cover image for
//     the email.

const kindle = require('./kindle');
const covers = require('./covers');
const coverstore = require('./coverstore');
const storage = require('./storage');

/**
 * A lazy, memoized loader for one stored book's Kindle attachment. The first
 * call fetches it (local: the path; r2: the object bytes); later calls — the
 * next recipient — reuse the same result, or the same failure.
 */
function attachmentLoader(savePath, store = storage.get()) {
  let pending = null;
  return () => {
    if (!pending) pending = store.attachment(savePath);
    return pending;
  };
}

/**
 * Push a book to one recipient's Kindle. Never throws. Returns
 *   { ok: true } | { ok: false, error } | { ok: false, skipped: true, error }
 * (skipped = the recipient has no Kindle address).
 */
async function pushToKindle(recipient, { filename, getAttachment }) {
  if (!recipient || !recipient.kindleEmail) return { ok: false, skipped: true, error: 'no Kindle email' };
  try {
    const att = await getAttachment();
    await kindle.pushToKindle({ kindleEmail: recipient.kindleEmail, filename, ...att });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Fill a missing cover and/or blurb on `book` (in place) from the catalog.
 * Only with an author: a title-only lookup can grab a different same-titled
 * book ("Whistler"), so with no author the blanks stay blank. One cached
 * resolveMeta call covers both fields. Never throws.
 */
async function fillMissingMeta(book) {
  if (!book.author || (book.cover && book.description)) return book;
  try {
    const meta = await covers.resolveMeta({ title: book.title, author: book.author });
    if (!book.cover && meta.cover) book.cover = meta.cover;
    if (!book.description && meta.description) book.description = meta.description;
  } catch { /* leave blanks — never block a send on metadata */ }
  return book;
}

/**
 * Attach the stored cover image (the same one the Library shows) to `book` as
 * coverBuffer/coverMime for the email. The ePUB step is skipped — it would
 * read the book a second time on top of the Kindle attachment — and a
 * generated SVG jacket arrives rasterized, since email clients won't render
 * SVG. Never throws; on failure the email falls back to the URL/placeholder.
 */
async function attachEmailCover(book, { savePath = null, filePresent = false } = {}) {
  try {
    const img = await coverstore.getEmailCoverImage({ ...book, savePath, filePresent }, { epub: false });
    if (img) { book.coverBuffer = img.bytes; book.coverMime = img.mime; }
  } catch { /* URL / placeholder fallback */ }
  return book;
}

module.exports = { attachmentLoader, pushToKindle, fillMissingMeta, attachEmailCover };
