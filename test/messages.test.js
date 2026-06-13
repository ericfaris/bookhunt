'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { classifyError } = require('../src/messages');

test('classifyError: needWarm flag → re-warm guidance, retryable', () => {
  const out = classifyError(new Error('whatever'), { needWarm: true });
  assert.equal(out.needWarm, true);
  assert.equal(out.retryable, true);
  assert.match(out.hint, /re-?warm/i);
});

test('classifyError: a "could not log in" message implies needWarm', () => {
  const out = classifyError('Could not log in to Mobilism.');
  assert.equal(out.needWarm, true);
  assert.equal(out.retryable, true);
});

test('classifyError: Cloudflare challenge → re-warm, retryable', () => {
  const out = classifyError('Just a moment... security verification');
  assert.equal(out.needWarm, true);
  assert.equal(out.retryable, true);
  assert.match(out.message, /cloudflare/i);
});

test('classifyError: timeout / 524 → slow, retryable, no warm', () => {
  for (const m of ['Navigation timeout of 30000 ms exceeded', 'got a 524', 'took too long']) {
    const out = classifyError(m);
    assert.equal(out.retryable, true, m);
    assert.equal(out.needWarm, false, m);
    assert.match(out.message, /too long|reach/i, m);
  }
});

test('classifyError: network errors → cannot reach, retryable', () => {
  const out = classifyError('net::ERR_CONNECTION_REFUSED');
  assert.equal(out.retryable, true);
  assert.match(out.message, /reach/i);
});

test('classifyError: expired premium account → terminal (not retryable)', () => {
  const out = classifyError('Premium account is expired (expired 2025-01-01). Renew it on Mobilism to download.');
  assert.equal(out.retryable, false);
  assert.match(out.hint, /renew/i);
});

test('classifyError: rejected premium credentials → terminal', () => {
  const out = classifyError('Premium login was rejected — check MOBILISM_PREMIUM_USER / PREMIUM_PASS.');
  assert.equal(out.retryable, false);
  assert.match(out.message, /credentials/i);
});

test('classifyError: profile locked / busy → retryable, no warm', () => {
  const out = classifyError('The browser profile is already in use by another session');
  assert.equal(out.retryable, true);
  assert.equal(out.needWarm, false);
});

test('classifyError: no usable download → terminal, suggests re-upload', () => {
  const out = classifyError('Every mirror failed');
  assert.equal(out.retryable, false);
  assert.match(out.hint, /re-?upload|another result/i);
});

test('classifyError: unknown error keeps original text, retryable', () => {
  const out = classifyError('Some weird thing happened');
  assert.equal(out.message, 'Some weird thing happened');
  assert.equal(out.retryable, true);
});

test('classifyError: empty input still yields a usable message', () => {
  const out = classifyError('');
  assert.ok(out.message.length > 0);
  assert.ok(out.hint.length > 0);
});

test('classifyError: every result has the full shape', () => {
  for (const m of ['', 'timeout', 'expired account', 'net::ERR', 'mystery']) {
    const out = classifyError(m);
    for (const k of ['message', 'hint', 'retryable', 'needWarm']) {
      assert.ok(k in out, `${m} missing ${k}`);
    }
  }
});
