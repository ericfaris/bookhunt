'use strict';

// Integration test for the REAL /api/search route (issue: warming loop). Disable
// Cloudflare Access BEFORE requiring the app so we can hit it in-process; dotenv
// won't override these already-set values.
process.env.CF_ACCESS_TEAM_DOMAIN = '';
process.env.CF_ACCESS_AUD = '';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const searcher = require('../src/searcher');
const correct = require('../src/correct');
const history = require('../src/history');
const { app } = require('../src/server');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// POST /api/search, collecting SSE `data:` frames. opts.abortOnFirstFrame aborts
// the request as soon as the first data frame arrives (simulates the user/tab
// going away mid-search). Resolves with the parsed frames received so far.
function search(port, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/search', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        const frames = [];
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk.toString();
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = frame.split('\n').find((l) => l.startsWith('data:'));
            if (line) {
              try { frames.push(JSON.parse(line.slice(5).trim())); } catch { /* ignore */ }
              if (opts.abortOnFirstFrame) { req.destroy(); resolve({ frames, aborted: true }); return; }
            }
          }
        });
        res.on('end', () => resolve({ frames, aborted: false }));
        res.on('close', () => resolve({ frames, aborted: false }));
      }
    );
    req.on('error', () => { /* aborts surface here — resolved above */ });
    req.write(payload);
    req.end();
  });
}

test('/api/search: a normal search streams a terminal done frame (no spurious cancel)', async () => {
  const orig = { search: searcher.search, correct: correct.correct, log: history.logSearch };
  correct.correct = async () => ({ corrected: false });
  history.logSearch = () => {};
  searcher.search = async (_params, onProgress) => {
    onProgress({ phase: 'title-search' });
    await delay(40);
    return { results: [{ title: 'The Astral Library', author: 'Kate Quinn' }], fallbackLinks: {} };
  };
  const server = await listen();
  try {
    const { frames } = await search(server.address().port, { title: 'The Astral Library', author: 'Kate Quinn' });
    const done = frames.find((f) => f.step === 'done');
    assert.ok(done, 'received a terminal done frame (not "ended unexpectedly")');
    assert.equal(done.results.length, 1);
  } finally {
    server.close();
    Object.assign(searcher, { search: orig.search });
    Object.assign(correct, { correct: orig.correct });
    Object.assign(history, { logSearch: orig.log });
  }
});

test('/api/search: a real mid-stream client disconnect cancels the scrape', async () => {
  const orig = { search: searcher.search, correct: correct.correct, log: history.logSearch };
  correct.correct = async () => ({ corrected: false });
  history.logSearch = () => {};

  let sawCancel = false;
  searcher.search = async (_params, onProgress, signal) => {
    onProgress({ phase: 'title-search' }); // first frame → triggers the client abort
    for (let i = 0; i < 100; i++) {
      if (signal && signal.cancelled) { sawCancel = true; throw new searcher.CancelledError(); }
      await delay(20);
    }
    return { results: [], fallbackLinks: {} };
  };

  const server = await listen();
  try {
    await search(server.address().port, { title: 'x' }, { abortOnFirstFrame: true });
    // Give the server a beat to observe the response 'close' and propagate cancel.
    for (let i = 0; i < 50 && !sawCancel; i++) await delay(20);
    assert.equal(sawCancel, true, 'the scrape saw the cancel signal after the client left');
  } finally {
    server.close();
    Object.assign(searcher, { search: orig.search });
    Object.assign(correct, { correct: orig.correct });
    Object.assign(history, { logSearch: orig.log });
  }
});
