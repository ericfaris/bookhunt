'use strict';

// src/sse.js over a real HTTP connection.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { openSSE } = require('../src/sse');

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('openSSE: headers, data frames, heartbeat comments, clean end', async () => {
  let ended = false;
  const server = await serve((req, res) => {
    const s = openSSE(res, { heartbeatMs: 30 });
    s.send({ step: 'progress', n: 1 });
    setTimeout(() => { s.send({ step: 'done' }); s.end(); ended = true; s.send({ step: 'late' }); }, 100);
  });
  const { port } = server.address();
  const body = await new Promise((resolve) => {
    http.get({ port, host: '127.0.0.1', path: '/' }, (res) => {
      assert.equal(res.headers['content-type'], 'text/event-stream');
      assert.equal(res.headers['x-accel-buffering'], 'no');
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve(b));
    });
  });
  server.close();
  assert.ok(ended);
  assert.match(body, /^data: \{"step":"progress","n":1\}\n\n/);
  assert.match(body, /: ping\n\n/, 'heartbeat sent while quiet');
  assert.match(body, /data: \{"step":"done"\}\n\n$/, 'nothing written after end()');
});

test('openSSE: onClientGone fires on a real disconnect, never after our own end()', async () => {
  let gone = 0;
  let finishedNormally = 0;
  const server = await serve((req, res) => {
    const s = openSSE(res, { heartbeatMs: 1000 });
    s.onClientGone(() => { gone += 1; });
    if (req.url === '/finish') { s.send({ step: 'done' }); s.end(); finishedNormally += 1; }
  });
  const { port } = server.address();
  // 1) normal finish → no cancel
  await new Promise((resolve) => http.get({ port, host: '127.0.0.1', path: '/finish' }, (r) => { r.resume(); r.on('end', resolve); }));
  // 2) client walks away mid-stream → cancel
  await new Promise((resolve) => {
    const req = http.get({ port, host: '127.0.0.1', path: '/hang' }, (r) => { r.once('data', () => { req.destroy(); setTimeout(resolve, 50); }); });
  });
  server.close();
  assert.equal(finishedNormally, 1);
  assert.equal(gone, 1, 'exactly the abandoned stream was cancelled');
});
