'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const downloader = require('../src/downloader');
const { ensurePremiumLogin, assertAccountActive, setPremiumCreds, clearPremiumCreds } = downloader;

// --- assertAccountActive ----------------------------------------------------
// Regression guard for the false-fatal bug (case 2): the downloader's per-link
// pages contain words like "invalid"/"incorrect" for bad LINKS, which must NOT
// be mistaken for a login rejection (that aborted all mirrors).

const pageWithBody = (text) => ({ async evaluate() { return text; } });

test('assertAccountActive: does NOT throw on "Invalid link?." (bad-link text)', async () => {
  await assert.doesNotReject(() => assertAccountActive(pageWithBody('Invalid link?.')));
  await assert.doesNotReject(() => assertAccountActive(pageWithBody('The page was not found!')));
  await assert.doesNotReject(() => assertAccountActive(pageWithBody('a perfectly normal page')));
});

test('assertAccountActive: still throws a fatal error on an expired account', async () => {
  await assert.rejects(
    () => assertAccountActive(pageWithBody('Your account expired. Expiration: 2026-04-21')),
    (err) => err.fatal === true && /expired/i.test(err.message)
  );
});

// --- ensurePremiumLogin -----------------------------------------------------
// Login rejection must be detected by the login form PERSISTING after submit,
// not by scanning page text.

function mockPage({ hasUsername = true, passwordAfterSubmit = false } = {}) {
  let submitted = false;
  return {
    async $(sel) {
      if (/username/.test(sel)) return hasUsername ? {} : null;
      if (/password/.test(sel)) {
        if (!submitted) return {}; // form present before submit
        return passwordAfterSubmit ? {} : null; // present after submit => rejected
      }
      return null;
    },
    async fill() {},
    async click() { submitted = true; },
    async waitForLoadState() {},
    async waitForTimeout() {},
  };
}

test('ensurePremiumLogin: no-op when no login form is shown', async () => {
  clearPremiumCreds();
  await assert.doesNotReject(() => ensurePremiumLogin(mockPage({ hasUsername: false })));
});

test('ensurePremiumLogin: succeeds when the form is gone after submit', async () => {
  setPremiumCreds('user', 'pass');
  await assert.doesNotReject(() => ensurePremiumLogin(mockPage({ passwordAfterSubmit: false })));
  clearPremiumCreds();
});

test('ensurePremiumLogin: throws fatal when the form persists after submit', async () => {
  setPremiumCreds('user', 'wrong');
  await assert.rejects(
    () => ensurePremiumLogin(mockPage({ passwordAfterSubmit: true })),
    (err) => err.fatal === true && /rejected/i.test(err.message)
  );
  clearPremiumCreds();
});
