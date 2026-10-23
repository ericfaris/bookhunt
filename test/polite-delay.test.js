'use strict';

// The polite gap between forum requests is measured from the previous request's
// start (searcher.politeWaitMs / randomDelay). Own file = own process, so the
// module-level "last request" clock starts idle.

const { test } = require('node:test');
const assert = require('node:assert');
const { politeWaitMs, randomDelay, createCancelSignal } = require('../src/searcher');

test('politeWaitMs: idle → no wait; recent request → only the remainder of the gap', () => {
  const now = 1_000_000;
  assert.equal(politeWaitMs(now, 0, 3000), 0, 'never requested before');
  assert.equal(politeWaitMs(now, now - 60_000, 3000), 0, 'idle for a minute');
  assert.equal(politeWaitMs(now, now - 1000, 3000), 2000, 'page took 1s → wait the other 2s');
  assert.equal(politeWaitMs(now, now, 3000), 3000, 'back-to-back → full gap');
  assert.equal(politeWaitMs(now, now + 5000, 3000), 3000, 'clock skew never exceeds the target');
});

test('randomDelay: first request after idle goes straight out; the next one still waits ≥2s', async () => {
  let t0 = Date.now();
  await randomDelay();
  assert.ok(Date.now() - t0 < 200, `idle request should not sleep (took ${Date.now() - t0}ms)`);

  // Immediately after: the full polite gap applies (cancel to keep the test fast,
  // but prove it WAS going to wait by checking it hadn't resolved early).
  const s = createCancelSignal();
  t0 = Date.now();
  let resolved = false;
  const p = randomDelay(s).then(() => { resolved = true; });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(resolved, false, 'back-to-back request must still wait (≥2s)');
  s.cancel();
  await p;
});
