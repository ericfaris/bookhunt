'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { classifyThanks, THANKERS_RE } = require('../src/thanks');

// --- classifyThanks: maps scrape signals → outcome + progress step -----------

test('classifyThanks: clicked → thanked (no post-click verification)', () => {
  const r = classifyThanks({ controlFoundBefore: true, clicked: true });
  assert.equal(r.status, 'thanked');
  assert.equal(r.step, 'thanked');
});

test('classifyThanks: clicked → thanked regardless of leftover signals', () => {
  // The page may still show a control after a real thank; a click is success.
  const r = classifyThanks({ controlFoundBefore: true, clicked: true, thankersListPresent: true });
  assert.equal(r.status, 'thanked');
  assert.equal(r.step, 'thanked');
});

test('classifyThanks: no control + a thankers block present → already-thanked (skip)', () => {
  const r = classifyThanks({ controlFoundBefore: false, clicked: false, thankersListPresent: true });
  assert.equal(r.status, 'already-thanked');
  assert.equal(r.step, 'thanks-skipped');
});

test('classifyThanks: no control + no thankers block → not-available (skip)', () => {
  const r = classifyThanks({ controlFoundBefore: false, clicked: false, thankersListPresent: false });
  assert.equal(r.status, 'not-available');
  assert.equal(r.step, 'thanks-skipped');
});

test('classifyThanks: control present but never clicked → thanks-failed', () => {
  const r = classifyThanks({ controlFoundBefore: true, clicked: false });
  assert.equal(r.status, 'unknown');
  assert.equal(r.step, 'thanks-failed');
});

test('classifyThanks: every outcome carries a non-empty message', () => {
  for (const sig of [
    { controlFoundBefore: true, clicked: true },
    { controlFoundBefore: true, clicked: false },
    { controlFoundBefore: false, clicked: false, thankersListPresent: true },
    { controlFoundBefore: false, clicked: false, thankersListPresent: false },
    {},
  ]) {
    const r = classifyThanks(sig);
    assert.ok(r.message && r.message.length > 0, `message for ${JSON.stringify(sig)}`);
  }
});

// --- THANKERS_RE: recognizes the "already thanked" block, not random text ----

test('THANKERS_RE: matches Mobilism thankers phrasing', () => {
  assert.ok(THANKERS_RE.test('The following 3 users say Thank You to juandelacruz for this post'));
  assert.ok(THANKERS_RE.test('5 users thanked the author'));
});

test('THANKERS_RE: does not match ordinary post text', () => {
  assert.equal(THANKERS_RE.test('Here is the book you requested. Enjoy!'), false);
});
