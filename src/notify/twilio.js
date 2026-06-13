'use strict';

// SMS/MMS notification channel via Twilio — SCAFFOLDED BUT NOT YET ACTIVE.
//
// To enable later:
//   1) npm install twilio
//   2) set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM in .env
//   3) replace the body of send() with the commented implementation below
//
// The contract (id/isConfigured/supports/send) matches the email channel, so
// the registry in ./index.js will pick it up automatically once configured —
// no changes needed in any caller.

const id = 'sms';
const label = 'SMS/MMS (Twilio)';

function isConfigured() {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM
  );
}

// Needs a phone number (E.164, e.g. +15551234567).
function supports(recipient) {
  return !!(recipient && recipient.phone);
}

/**
 * book: { title, author, cover, ... }
 */
async function send({ recipient, book }) {
  // --- Future implementation -------------------------------------------------
  // const twilio = require('twilio')(
  //   process.env.TWILIO_ACCOUNT_SID,
  //   process.env.TWILIO_AUTH_TOKEN
  // );
  // const author = book.author ? ` by ${book.author}` : '';
  // await twilio.messages.create({
  //   from: process.env.TWILIO_FROM,
  //   to: recipient.phone,
  //   body: `📚 ${book.title || book.filename}${author} was added to your Kindle.`,
  //   // MMS cover (US/CA only); harmless to include — Twilio ignores if MMS N/A.
  //   ...(book.cover ? { mediaUrl: [book.cover] } : {}),
  // });
  // ---------------------------------------------------------------------------
  throw new Error('Twilio SMS/MMS channel is not enabled yet (see src/notify/twilio.js)');
}

module.exports = { id, label, isConfigured, supports, send };
