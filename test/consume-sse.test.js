'use strict';

// public/app.js consumeSSE(): the single browser-side reader for the search,
// download and batch streams. Extracted from the real file so the test runs the
// shipped code, fed through a real ReadableStream with awkward chunking.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const m = src.match(/async function consumeSSE\(res, onEvent\) \{[\s\S]*?\n\}\n/);
assert.ok(m, 'consumeSSE not found in public/app.js');
const consumeSSE = new Function(`${m[0]}; return consumeSSE;`)();

function responseFrom(chunks) {
  const enc = new TextEncoder();
  return { body: new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } }) };
}

test('consumeSSE: reassembles frames split across chunks, skips heartbeats and junk', async () => {
  const events = [];
  await consumeSSE(responseFrom([
    'data: {"step":"pro', 'gress","n":1}\n', '\n',          // split mid-JSON and mid-delimiter
    ': ping\n\n',                                              // heartbeat
    'data: not json\n\n',                                      // malformed — skipped
    'data: {"step":"library","books":[{"t":"é ✓"}]}\n\ndata: {"step":"done","results":[]}\n\n',
  ]), (ev) => events.push(ev));
  assert.deepEqual(events, [
    { step: 'progress', n: 1 },
    { step: 'library', books: [{ t: 'é ✓' }] },
    { step: 'done', results: [] },
  ]);
});

test('consumeSSE: multi-byte characters split across chunks decode correctly', async () => {
  const bytes = new TextEncoder().encode('data: {"t":"Zoë — ✓"}\n\n');
  const body = new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(new Uint8Array([b])); c.close(); } });
  const events = [];
  await consumeSSE({ body }, (ev) => events.push(ev));
  assert.deepEqual(events, [{ t: 'Zoë — ✓' }]);
});

test('public/app.js: no hand-rolled SSE readers left besides consumeSSE', () => {
  assert.equal((src.match(/getReader\(\)/g) || []).length, 1);
});
