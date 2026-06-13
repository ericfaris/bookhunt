'use strict';

// Shared Gmail SMTP transport, used by both the email notification channel and
// the Send-to-Kindle push. Credentials come from the environment (.env); the
// From address is fixed to your Gmail so it can be on each recipient's Amazon
// "Approved Personal Document E-mail List".

const nodemailer = require('nodemailer');

const FROM = process.env.SMTP_FROM || process.env.SMTP_USER || '';

let _transport = null;

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransport() {
  if (!isConfigured()) {
    throw new Error('SMTP is not configured — set SMTP_USER and SMTP_PASS (Gmail App Password) in .env');
  }
  if (!_transport) {
    _transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465, // 587 uses STARTTLS
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return _transport;
}

module.exports = { FROM, isConfigured, getTransport };
