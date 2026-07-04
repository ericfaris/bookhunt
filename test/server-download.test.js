'use strict';

// Integration tests for the REAL /api/download route with fallback candidates
// (batch mode): when an entry matched several posts, the endpoint must keep
// trying — and verifying — each candidate post until one yields the right
// book, instead of stopping at the first post's first saved file. Disable
// Cloudflare Access BEFORE requiring the app so we can hit it in-process.
process.env.CF_ACCESS_TEAM_DOMAIN = '';
process.env.CF_ACCESS_AUD = '';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const downloader = require('../src/downloader');
const history = require('../src/history');
const covers = require('../src/covers');
const { app } = require('../src/server');

const URL1 = 'https://forum.mobilism.org/viewtopic.php?t=1';
const URL2 = 'https://forum.mobilism.org/viewtopic.php?t=2';
const URL3 = 'https://forum.mobilism.org/viewtopic.php?t=3';

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// POST /api/download and collect the SSE `data:` frames (or the JSON error for
// a non-200 status).
function download(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/download', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let buf = '';
        const frames = [];
        res.on('data', (chunk) => {
          buf += chunk.toString();
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = frame.split('\n').find((l) => l.startsWith('data:'));
            if (line) { try { frames.push(JSON.parse(line.slice(5).trim())); } catch { /* ignore */ } }
          }
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            let json = null;
            try { json = JSON.parse(buf); } catch { /* ignore */ }
            resolve({ status: res.statusCode, json, frames: [] });
          } else {
            resolve({ status: 200, frames });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Stub the world around the route: premium creds present, history/covers inert,
// and premiumDownload scripted per topic URL. Returns the recorded state and a
// restore function.
function stubWorld(script) {
  const orig = {
    premiumDownload: downloader.premiumDownload,
    hasCreds: downloader.hasPremiumCreds,
    logDownload: history.logDownload,
    resolveCover: covers.resolveCover,
  };
  const state = { calls: [], logged: [] };
  downloader.hasPremiumCreds = () => true;
  covers.resolveCover = async () => null;
  history.logDownload = (entry) => { state.logged.push(entry); return { id: 'dl-' + state.logged.length }; };
  downloader.premiumDownload = async (url, _onProgress, targetTitle) => {
    state.calls.push({ url, targetTitle });
    const o = script[url] || { error: 'unexpected url ' + url };
    if (o.error) { const e = new Error(o.error); if (o.needWarm) e.needWarm = true; throw e; }
    return o.result;
  };
  const restore = () => {
    Object.assign(downloader, { premiumDownload: orig.premiumDownload, hasPremiumCreds: orig.hasCreds });
    Object.assign(history, { logDownload: orig.logDownload });
    Object.assign(covers, { resolveCover: orig.resolveCover });
  };
  return { state, restore };
}

const wrongBook = {
  downloads: [{ filename: 'wrong.epub', savePath: null, url: 'm1', verified: true, titleMatch: false, embeddedTitle: 'Another Book' }],
  errors: [], title: 'Wrong Post', description: '',
};
const rightBook = {
  downloads: [{ filename: 'right.epub', savePath: null, url: 'm2', verified: true, titleMatch: true, embeddedTitle: 'The Book' }],
  errors: [], title: 'Right Post', description: 'desc',
};

test('/api/download: falls through candidate posts until one verifies', async () => {
  const { state, restore } = stubWorld({ [URL1]: { result: wrongBook }, [URL2]: { result: rightBook } });
  const server = await listen();
  try {
    const { status, frames } = await download(server.address().port, {
      url: URL1, title: 'Wrong Post', searchedTitle: 'The Book',
      candidates: [{ url: URL2, title: 'Right Post' }],
    });
    assert.equal(status, 200);
    assert.deepEqual(state.calls.map((c) => c.url), [URL1, URL2], 'both posts were tried in order');
    assert.equal(state.calls[1].targetTitle, 'The Book', 'verification target stays the searched title');

    const candidateFrames = frames.filter((f) => f.step === 'candidate');
    assert.deepEqual(candidateFrames.map((f) => f.index), [1, 2], 'each post announced itself');

    const done = frames.find((f) => f.step === 'done');
    assert.ok(done, 'received a terminal done frame');
    assert.equal(done.downloads.length, 1);
    assert.equal(done.downloads[0].filename, 'right.epub', 'the verified book won');
    assert.equal(done.title, 'Right Post');
    assert.ok(done.errors.some((e) => e.url === URL1 && /did not verify/i.test(e.error)),
      'the rejected first post is reported');

    assert.equal(state.logged.length, 1, 'only the accepted download is logged to history');
    assert.equal(state.logged[0].filename, 'right.epub');
    assert.equal(state.logged[0].title, 'The Book', 'logged under the searched title');
  } finally {
    server.close();
    restore();
  }
});

test('/api/download: a candidate that errors is skipped, later ones still tried', async () => {
  const { state, restore } = stubWorld({
    [URL1]: { error: 'No Premium icon found on this post' },
    [URL2]: { result: rightBook },
  });
  const server = await listen();
  try {
    const { frames } = await download(server.address().port, {
      url: URL1, searchedTitle: 'The Book', candidates: [{ url: URL2 }],
    });
    assert.deepEqual(state.calls.map((c) => c.url), [URL1, URL2]);
    assert.ok(frames.some((f) => f.step === 'candidate-failed' && f.index === 1));
    const done = frames.find((f) => f.step === 'done');
    assert.equal(done.downloads[0].filename, 'right.epub');
  } finally {
    server.close();
    restore();
  }
});

test('/api/download: when no candidate verifies, the best fallback is still delivered', async () => {
  const { state, restore } = stubWorld({
    [URL1]: { error: 'mirror died' },
    [URL2]: { result: wrongBook },
  });
  const server = await listen();
  try {
    const { frames } = await download(server.address().port, {
      url: URL1, searchedTitle: 'The Book', candidates: [{ url: URL2 }],
    });
    assert.equal(state.calls.length, 2);
    const done = frames.find((f) => f.step === 'done');
    assert.ok(done, 'still terminates with a done frame');
    assert.equal(done.downloads[0].filename, 'wrong.epub', 'the unmatched download is returned for the user to judge');
    assert.equal(done.downloads[0].titleMatch, false, 'flagged so the UI can warn');
    assert.ok(done.errors.some((e) => /mirror died/.test(e.error)));
  } finally {
    server.close();
    restore();
  }
});

test('/api/download: an error on every candidate becomes a terminal error frame', async () => {
  const { restore } = stubWorld({
    [URL1]: { error: 'fail one' },
    [URL2]: { error: 'fail two' },
  });
  const server = await listen();
  try {
    const { frames } = await download(server.address().port, {
      url: URL1, searchedTitle: 'The Book', candidates: [{ url: URL2 }],
    });
    const error = frames.find((f) => f.step === 'error');
    assert.ok(error, 'terminal error frame delivered over SSE');
    assert.ok(!frames.some((f) => f.step === 'done'));
  } finally {
    server.close();
    restore();
  }
});

test('/api/download: a needWarm candidate error aborts instead of grinding through the list', async () => {
  const { state, restore } = stubWorld({
    [URL1]: { error: 'Mobilism session expired', needWarm: true },
    [URL2]: { result: rightBook }, // must NOT be reached
  });
  const server = await listen();
  try {
    const { frames } = await download(server.address().port, {
      url: URL1, searchedTitle: 'The Book', candidates: [{ url: URL2 }],
    });
    assert.equal(state.calls.length, 1, 'no further posts tried after a session-level failure');
    const error = frames.find((f) => f.step === 'error');
    assert.ok(error && error.needWarm, 'error frame carries needWarm for the re-warm banner');
  } finally {
    server.close();
    restore();
  }
});

test('/api/download: rejects a non-forum candidate URL before doing any work', async () => {
  const { state, restore } = stubWorld({});
  const server = await listen();
  try {
    const { status, json } = await download(server.address().port, {
      url: URL1, candidates: [{ url: 'https://evil.example.com/steal' }],
    });
    assert.equal(status, 400);
    assert.match(json.error, /candidate URL/i);
    assert.equal(state.calls.length, 0, 'nothing was navigated');
  } finally {
    server.close();
    restore();
  }
});

test('/api/download: candidate list is deduped and capped', async () => {
  // 30 distinct failing candidates + the primary: only 10 posts total may run.
  const script = { [URL1]: { error: 'fail' } };
  const candidates = [{ url: URL1 }]; // duplicate of the primary — must be dropped
  for (let i = 0; i < 30; i++) {
    const u = `https://forum.mobilism.org/viewtopic.php?t=${100 + i}`;
    script[u] = { error: 'fail' };
    candidates.push({ url: u });
  }
  const { state, restore } = stubWorld(script);
  const server = await listen();
  try {
    await download(server.address().port, { url: URL1, searchedTitle: 'X', candidates });
    assert.equal(state.calls.length, 10, 'at most 10 posts are scraped per request');
    assert.equal(new Set(state.calls.map((c) => c.url)).size, state.calls.length, 'no post tried twice');
  } finally {
    server.close();
    restore();
  }
});

test('/api/download: plain single-post download is unchanged (no candidate frames)', async () => {
  const { state, restore } = stubWorld({ [URL3]: { result: rightBook } });
  const server = await listen();
  try {
    const { frames } = await download(server.address().port, { url: URL3, title: 'Right Post' });
    assert.equal(state.calls.length, 1);
    assert.equal(frames.filter((f) => f.step === 'candidate').length, 0, 'single downloads grow no new steps');
    const done = frames.find((f) => f.step === 'done');
    assert.equal(done.downloads[0].filename, 'right.epub');
    assert.ok(done.downloads[0].id, 'logged download id is stamped for /api/send');
  } finally {
    server.close();
    restore();
  }
});
