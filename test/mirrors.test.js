'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runMirrors, runCandidates, downloadRank } = require('../src/downloader');

// Create a real throwaway file so tests can assert that rejected downloads are
// actually deleted from disk.
function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-mirrors-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'x');
  return p;
}

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

// --- Verification fall-through: a save is only "good" if it verifies ---------

test('runMirrors: a wrong-book save keeps trying and a verified match wins', async () => {
  const wrongPath = tmpFile('wrong.epub');
  const { fn, state } = scriptedAttempt([
    { file: { filename: 'wrong.epub', savePath: wrongPath, verified: true, titleMatch: false, embeddedTitle: 'Another Book' } },
    { error: 'fail b' },
    { file: goodFile },
    { file: { filename: 'd.epub' } }, // must NOT be reached
  ]);
  const events = [];
  const { downloads, errors } = await runMirrors(links, fn, (ev) => events.push(ev));

  assert.equal(state.calls, 3, 'kept trying past the wrong-book save, stopped at the verified one');
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].url, 'c', 'the verified mirror is the one returned');
  assert.equal(fs.existsSync(wrongPath), false, 'the superseded wrong-book file was deleted');
  assert.ok(errors.some((e) => e.url === 'a' && /embedded title/i.test(e.error)), 'the rejected save is recorded');
  const mismatch = events.find((e) => e.step === 'mirror-mismatch');
  assert.ok(mismatch, 'a mirror-mismatch progress event was emitted');
  assert.equal(mismatch.embeddedTitle, 'Another Book');
});

test('runMirrors: an unverified save keeps trying, but is returned as a fallback when nothing verifies', async () => {
  const badPath = tmpFile('bad.epub');
  const { fn, state } = scriptedAttempt([
    { file: { filename: 'bad.epub', savePath: badPath, verified: false } },
    { error: 'fail b' },
    { error: 'fail c' },
    { error: 'fail d' },
  ]);
  const { downloads, errors } = await runMirrors(links, fn);

  assert.equal(state.calls, 4, 'all mirrors were tried after the unverified save');
  assert.equal(downloads.length, 1, 'the unverified save is still returned as a fallback');
  assert.equal(downloads[0].url, 'a');
  assert.equal(downloads[0].verified, false);
  assert.equal(fs.existsSync(badPath), true, 'the fallback file is kept on disk');
  assert.equal(errors.length, 3, 'the returned fallback is not double-counted as an error');
});

test('runMirrors: a verified wrong-title save outranks an unverified one as the fallback', async () => {
  const badPath = tmpFile('bad.epub');
  const wrongPath = tmpFile('wrong.epub');
  const { fn } = scriptedAttempt([
    { file: { filename: 'bad.epub', savePath: badPath, verified: false } },
    { file: { filename: 'wrong.epub', savePath: wrongPath, verified: true, titleMatch: false, embeddedTitle: 'Other' } },
    { error: 'fail c' },
    { error: 'fail d' },
  ]);
  const { downloads } = await runMirrors(links, fn);

  assert.equal(downloads[0].url, 'b', 'the structurally-valid save wins the fallback slot');
  assert.equal(fs.existsSync(badPath), false, 'the inferior fallback file was deleted');
  assert.equal(fs.existsSync(wrongPath), true, 'the kept fallback file survives');
});

test('runMirrors: titleMatch null (no embedded title) is accepted immediately', async () => {
  const { fn, state } = scriptedAttempt([
    { file: { filename: 'a.epub', savePath: '/dl/a.epub', verified: true, titleMatch: null } },
    { file: goodFile }, // must NOT be reached
  ]);
  const { downloads } = await runMirrors(links, fn);
  assert.equal(state.calls, 1, 'a valid ePUB with no title to compare is good enough');
  assert.equal(downloads[0].url, 'a');
});

test('downloadRank: orders verified-match > verified-wrong-title > unverified > nothing', () => {
  assert.equal(downloadRank({ verified: true, titleMatch: true }), 3);
  assert.equal(downloadRank({ verified: true, titleMatch: null }), 3);
  assert.equal(downloadRank({ verified: true, titleMatch: false }), 2);
  assert.equal(downloadRank({ verified: false }), 1);
  assert.equal(downloadRank(null), 0);
});

// --- runCandidates: walk every matched post until one verifies ---------------

const posts = [
  { url: 'https://forum.mobilism.org/t/1', title: 'Post One' },
  { url: 'https://forum.mobilism.org/t/2', title: 'Post Two' },
  { url: 'https://forum.mobilism.org/t/3', title: 'Post Three' },
];

function scriptedCandidates(outcomes) {
  const state = { calls: 0 };
  const fn = async () => {
    const o = outcomes[state.calls] || { error: 'no outcome' };
    state.calls++;
    if (o.fatal) { const e = new Error(o.fatal); e.fatal = true; throw e; }
    if (o.needWarm) { const e = new Error(o.needWarm); e.needWarm = true; throw e; }
    if (o.error) throw new Error(o.error);
    return o.result;
  };
  return { fn, state };
}

const verifiedResult = {
  downloads: [{ filename: 'right.epub', savePath: '/dl/right.epub', verified: true, titleMatch: true }],
  errors: [], title: 'The Right Book', description: 'd',
};

test('runCandidates: stops at the first post whose download verifies', async () => {
  const { fn, state } = scriptedCandidates([
    { result: verifiedResult },
    { result: { downloads: [], errors: [] } }, // must NOT be reached
  ]);
  const events = [];
  const { result, tried } = await runCandidates(posts, fn, (ev) => events.push(ev));
  assert.equal(state.calls, 1);
  assert.equal(tried, 1);
  assert.equal(result.downloads[0].filename, 'right.epub');
  assert.deepEqual(
    events.filter((e) => e.step === 'candidate').map((e) => e.index),
    [1],
    'candidate progress announces each post tried'
  );
});

test('runCandidates: a wrong-book post is superseded by a later verified one', async () => {
  const wrongPath = tmpFile('wrong.epub');
  const { fn, state } = scriptedCandidates([
    { result: { downloads: [{ filename: 'wrong.epub', savePath: wrongPath, verified: true, titleMatch: false }], errors: [], title: 'Wrong' } },
    { result: verifiedResult },
  ]);
  const events = [];
  const { result, errors } = await runCandidates(posts, fn, (ev) => events.push(ev));

  assert.equal(state.calls, 2, 'the second post was tried after the first failed verification');
  assert.equal(result.title, 'The Right Book');
  assert.equal(result.downloads[0].verified, true);
  assert.equal(fs.existsSync(wrongPath), false, 'the superseded post’s file was deleted');
  assert.ok(errors.some((e) => e.url === posts[0].url && /did not verify/i.test(e.error)));
});

test('runCandidates: a failing post is skipped and later posts still run', async () => {
  const { fn, state } = scriptedCandidates([
    { error: 'No Premium icon found on this post' },
    { result: verifiedResult },
  ]);
  const events = [];
  const { result, errors } = await runCandidates(posts, fn, (ev) => events.push(ev));
  assert.equal(state.calls, 2);
  assert.equal(result.downloads[0].filename, 'right.epub');
  assert.ok(errors.some((e) => /premium icon/i.test(e.error)));
  assert.ok(events.some((e) => e.step === 'candidate-failed' && e.index === 1));
});

test('runCandidates: keeps the best fallback when no post verifies', async () => {
  const badPath = tmpFile('bad.epub');
  const wrongPath = tmpFile('wrong.epub');
  const { fn, state } = scriptedCandidates([
    { result: { downloads: [{ filename: 'bad.epub', savePath: badPath, verified: false }], errors: [], title: 'Bad' } },
    { result: { downloads: [{ filename: 'wrong.epub', savePath: wrongPath, verified: true, titleMatch: false }], errors: [], title: 'Wrong' } },
    { error: 'mirrors all failed' },
  ]);
  const { result } = await runCandidates(posts, fn);
  assert.equal(state.calls, 3, 'every post was tried looking for a verified match');
  assert.equal(result.title, 'Wrong', 'the verified-but-wrong-title post is the best fallback');
  assert.equal(fs.existsSync(badPath), false, 'the weaker fallback file was deleted');
  assert.equal(fs.existsSync(wrongPath), true, 'the returned fallback file is kept');
});

test('runCandidates: throws when every post fails outright', async () => {
  const { fn } = scriptedCandidates([
    { error: 'fail one' },
    { error: 'fail two' },
    { error: 'fail three' },
  ]);
  await assert.rejects(() => runCandidates(posts, fn), /fail three/);
});

test('runCandidates: fatal and needWarm errors abort the walk immediately', async () => {
  for (const key of ['fatal', 'needWarm']) {
    const { fn, state } = scriptedCandidates([
      { [key]: 'account-level failure' },
      { result: verifiedResult }, // must NOT be reached
    ]);
    await assert.rejects(() => runCandidates(posts, fn), /account-level/);
    assert.equal(state.calls, 1, `${key} stopped the remaining posts`);
  }
});

// Every attempt saves under the same title-derived filename, so a superseded
// download's savePath is often the SAME path the winner's file now lives at.
// Discarding the loser must not delete the winner's file (the "Project Hail
// Mary" bug: the verified epub vanished because candidate 1's rejected record
// pointed at the very path candidate 2 had just verified).
test('runMirrors: discarding a superseded fallback never deletes the winner at the same path', async () => {
  const sharedPath = tmpFile('book.epub');
  const { fn } = scriptedAttempt([
    { file: { filename: 'book.epub', savePath: sharedPath, verified: false } },
    { file: { filename: 'book.epub', savePath: sharedPath, verified: true, titleMatch: true } },
  ]);
  const { downloads, errors } = await runMirrors(links, fn);
  assert.equal(downloads[0].verified, true);
  assert.equal(fs.existsSync(sharedPath), true, 'the verified winner’s file survives the fallback discard');
  assert.ok(errors.some((e) => e.url === 'a'), 'the rejected mirror is still recorded');
});

test('runCandidates: replacing a fallback candidate never deletes the winner at the same path', async () => {
  const sharedPath = tmpFile('book.epub');
  const { fn } = scriptedCandidates([
    { result: { downloads: [{ filename: 'book.epub', savePath: sharedPath, verified: false }], errors: [], title: 'Bad' } },
    { result: { downloads: [{ filename: 'book.epub', savePath: sharedPath, verified: true, titleMatch: true }], errors: [], title: 'The Right Book' } },
  ]);
  const { result, errors } = await runCandidates(posts, fn);
  assert.equal(result.title, 'The Right Book');
  assert.equal(fs.existsSync(sharedPath), true, 'the verified winner’s file survives the fallback discard');
  assert.ok(errors.some((e) => e.url === posts[0].url && /replaced it/i.test(e.error)));
});

test('runCandidates: discarding an inferior later candidate never deletes the kept file at the same path', async () => {
  const sharedPath = tmpFile('book.epub');
  const { fn } = scriptedCandidates([
    { result: { downloads: [{ filename: 'book.epub', savePath: sharedPath, verified: true, titleMatch: false }], errors: [], title: 'Wrong' } },
    { result: { downloads: [{ filename: 'book.epub', savePath: sharedPath, verified: false }], errors: [], title: 'Bad' } },
  ]);
  const { result } = await runCandidates(posts, fn);
  assert.equal(result.title, 'Wrong', 'the earlier, better fallback is kept');
  assert.equal(fs.existsSync(sharedPath), true, 'the kept fallback’s file survives the rival discard');
});

test('runCandidates: a single post emits no candidate progress frames (back-compat)', async () => {
  const { fn } = scriptedCandidates([{ result: verifiedResult }]);
  const events = [];
  await runCandidates([posts[0]], fn, (ev) => events.push(ev));
  assert.equal(events.filter((e) => e.step === 'candidate').length, 0);
});
