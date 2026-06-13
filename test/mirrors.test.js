'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { runMirrors } = require('../src/downloader');

// Build an `attempt` from a per-link script of outcomes, and count calls so we
// can assert that the loop STOPS at the first success (later mirrors untried).
function scriptedAttempt(outcomes) {
  const state = { calls: 0 };
  const fn = async () => {
    const o = outcomes[state.calls] || { error: 'no outcome' };
    state.calls++;
    if (o.fatal) {
      const e = new Error(o.fatal);
      e.fatal = true;
      throw e;
    }
    if (o.error) throw new Error(o.error);
    return o.file; // { filename, savePath, verified, size }
  };
  return { fn, state };
}

const links = [{ url: 'a' }, { url: 'b' }, { url: 'c' }, { url: 'd' }];
const goodFile = { filename: 'c.epub', savePath: '/dl/c.epub', verified: true, size: 100 };

test('runMirrors: stops at the first successful mirror', async () => {
  const { fn, state } = scriptedAttempt([
    { error: 'fail a' },
    { error: 'fail b' },
    { file: goodFile },
    { file: { filename: 'd.epub' } }, // must NOT be reached
  ]);
  const { downloads, errors } = await runMirrors(links, fn);

  assert.equal(state.calls, 3, 'should stop after the first success (d untried)');
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].url, 'c');
  assert.equal(downloads[0].filename, 'c.epub');
  assert.ok(downloads[0].timestamp, 'success entry gets a timestamp');
  assert.deepEqual(errors.map((e) => e.url), ['a', 'b']);
});

test('runMirrors: succeeds immediately on the first mirror', async () => {
  const { fn, state } = scriptedAttempt([{ file: goodFile }]);
  const { downloads, errors } = await runMirrors(links, fn);
  assert.equal(state.calls, 1);
  assert.equal(downloads.length, 1);
  assert.equal(errors.length, 0);
});

test('runMirrors: records every failure when all mirrors fail', async () => {
  const { fn, state } = scriptedAttempt([
    { error: 'fail a' },
    { error: 'fail b' },
    { error: 'fail c' },
    { error: 'fail d' },
  ]);
  const { downloads, errors } = await runMirrors(links, fn);
  assert.equal(state.calls, 4);
  assert.equal(downloads.length, 0);
  assert.equal(errors.length, 4);
  assert.equal(errors[0].error, 'fail a');
});

test('runMirrors: a fatal error aborts the whole run', async () => {
  const { fn, state } = scriptedAttempt([
    { error: 'fail a' },
    { fatal: 'Premium account is expired' },
    { file: goodFile }, // must NOT be reached
  ]);
  await assert.rejects(
    () => runMirrors(links, fn),
    (err) => err.fatal === true && /expired/i.test(err.message)
  );
  assert.equal(state.calls, 2, 'aborts on the fatal mirror; later mirrors untried');
});

test('runMirrors: empty link list yields empty results', async () => {
  const { fn, state } = scriptedAttempt([]);
  const { downloads, errors } = await runMirrors([], fn);
  assert.equal(state.calls, 0);
  assert.deepEqual(downloads, []);
  assert.deepEqual(errors, []);
});

test('runMirrors: reports mirror + mirror-failed progress events', async () => {
  const hostLinks = [{ url: 'a', host: 'HostA' }, { url: 'b', host: 'HostB' }];
  const { fn } = scriptedAttempt([{ error: 'fail a' }, { file: goodFile }]);
  const events = [];
  await runMirrors(hostLinks, fn, (ev) => events.push(ev));

  // Each mirror announces itself with its index/total/host.
  assert.deepEqual(
    events.filter((e) => e.step === 'mirror'),
    [
      { step: 'mirror', index: 1, total: 2, host: 'HostA' },
      { step: 'mirror', index: 2, total: 2, host: 'HostB' },
    ]
  );
  // The first mirror's failure is reported with its reason.
  assert.deepEqual(events.filter((e) => e.step === 'mirror-failed'), [
    { step: 'mirror-failed', host: 'HostA', error: 'fail a' },
  ]);
});

test('runMirrors: works without an onProgress callback (back-compat)', async () => {
  const { fn } = scriptedAttempt([{ file: goodFile }]);
  const { downloads } = await runMirrors([{ url: 'a' }], fn); // 2-arg form
  assert.equal(downloads.length, 1);
});
