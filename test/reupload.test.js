'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { scanReuploadText, classifyReupload } = require('../src/reupload');

// --- scanReuploadText: page text → boolean signals --------------------------

test('scanReuploadText: detects a success confirmation', () => {
  const s = scanReuploadText('Thank you, the uploader has been notified.');
  assert.equal(s.success, true);
  assert.equal(s.alreadyRequested, false);
});

test('scanReuploadText: detects an already-requested / cooldown notice', () => {
  for (const txt of [
    'A re-upload has already been requested for this topic.',
    'You have already asked for a re-upload.',
    'Your request is pending.',
    'You can request a re-upload again in 24 hours.',
  ]) {
    const s = scanReuploadText(txt);
    assert.equal(s.alreadyRequested, true, txt);
    assert.equal(s.success, false, txt);
  }
});

test('scanReuploadText: already-requested wins over a generic thank-you', () => {
  const s = scanReuploadText('Thank you. You have already requested a re-upload.');
  assert.equal(s.alreadyRequested, true);
  assert.equal(s.success, false);
});

test('scanReuploadText: neutral page yields no signals', () => {
  const s = scanReuploadText('Some unrelated forum post about books.');
  assert.equal(s.success, false);
  assert.equal(s.alreadyRequested, false);
});

test('scanReuploadText: tolerates empty/undefined input', () => {
  assert.deepEqual(scanReuploadText(undefined), { alreadyRequested: false, success: false });
  assert.deepEqual(scanReuploadText(''), { alreadyRequested: false, success: false });
});

// --- classifyReupload: signals → client outcome -----------------------------

test('classifyReupload: success', () => {
  const out = classifyReupload({ controlFound: true, success: true, alreadyRequested: false });
  assert.equal(out.status, 'success');
  assert.match(out.message, /notified/i);
});

test('classifyReupload: already-requested takes priority', () => {
  const out = classifyReupload({ controlFound: true, success: true, alreadyRequested: true });
  assert.equal(out.status, 'already-requested');
});

test('classifyReupload: no control found → not-available', () => {
  const out = classifyReupload({ controlFound: false, success: false, alreadyRequested: false });
  assert.equal(out.status, 'not-available');
});

test('classifyReupload: clicked but unconfirmed → unknown', () => {
  const out = classifyReupload({ controlFound: true, success: false, alreadyRequested: false });
  assert.equal(out.status, 'unknown');
  assert.match(out.message, /couldn.?t confirm/i);
});

test('classifyReupload: every outcome carries a non-empty message', () => {
  const cases = [
    { controlFound: true, success: true, alreadyRequested: false },
    { controlFound: true, success: false, alreadyRequested: true },
    { controlFound: false, success: false, alreadyRequested: false },
    { controlFound: true, success: false, alreadyRequested: false },
  ];
  for (const c of cases) {
    const out = classifyReupload(c);
    assert.ok(out.message && out.message.length > 0);
    assert.ok(['success', 'already-requested', 'not-available', 'unknown'].includes(out.status));
  }
});
