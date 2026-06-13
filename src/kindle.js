'use strict';

// Send-to-Kindle push: emails an .epub as an attachment to a recipient's
// @kindle.com address. Amazon ingests the attachment and delivers the book to
// their device. Subject/body are ignored by Amazon for personal documents — the
// library entry comes from the EPUB's own metadata — so we keep them minimal.
//
// The From address (smtp.FROM, your Gmail) MUST be on the recipient's Amazon
// "Approved Personal Document E-mail List" or Amazon will silently reject it.

const path = require('path');
const smtp = require('./smtp');

function isConfigured() {
  return smtp.isConfigured();
}

async function pushToKindle({ kindleEmail, filePath, filename }) {
  if (!kindleEmail) throw new Error('No Kindle email for this recipient');
  const name = filename || path.basename(filePath);
  await smtp.getTransport().sendMail({
    from: smtp.FROM,
    to: kindleEmail,
    subject: name, // ignored by Amazon, but useful in your Sent folder
    text: 'Sent from Mobilism Finder',
    attachments: [{ filename: name, path: filePath, contentType: 'application/epub+zip' }],
  });
}

module.exports = { isConfigured, pushToKindle };
