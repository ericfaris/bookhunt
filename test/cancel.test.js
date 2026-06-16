'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  createCancelSignal,
  throwIfCancelled,
  CancelledError,
  randomDelay,
} = require('../src/searcher');

// --- throwIfCancelled --------------------------------------------------------

test('throwIfCancelled: no-op without a signal or when not cancelled', () => {
  assert.doesNotThrow(() => throwIfCancelled(undefined));
  assert.doesNotThrow(() => throwIfCancelled(createCancelSignal()));
});

test('throwIfCancelled: throws CancelledError once cancelled', () => {
  const s = createCancelSignal();
  s.cancel();
  assert.throws(() => throwIfCancelled(s), (e) => e instanceof CancelledError && e.cancelled === true);
});

// --- createCancelSignal ------------------------------------------------------

test('cancel(): flips cancelled and fires each listener exactly once', () => {
  const s = createCancelSignal();
  let calls = 0;
  s.onCancel(() => { calls++; });
  assert.equal(s.cancelled, false);
  s.cancel();
  s.cancel(); // idempotent
  assert.equal(s.cancelled, true);
  assert.equal(calls, 1);
});

test('onCancel(): a listener registered after cancel fires immediately', () => {
  const s = createCancelSignal();
  s.cancel();
  let fired = false;
  s.onCancel(() => { fired = true; });
  assert.equal(fired, true);
});

test('settle(): a later cancel no longer fires listeners (no late stop())', () => {
  const s = createCancelSignal();
  let fired = false;
  s.onCancel(() => { fired = true; });
  s.settle();
  s.cancel();
  assert.equal(fired, false);
  assert.equal(s.cancelled, false);
});

// --- randomDelay(signal): the polite gap aborts early on cancel --------------

test('randomDelay(signal): resolves promptly when cancelled mid-wait', async () => {
  const s = createCancelSignal();
  const started = Date.now();
  const p = randomDelay(s);
  s.cancel(); // would otherwise block 2–5s
  await p;
  assert.ok(Date.now() - started < 500, 'cancelled delay should resolve fast');
});

test('randomDelay(): without a signal still waits (returns a promise)', () => {
  const p = randomDelay();
  assert.ok(p instanceof Promise);
});
