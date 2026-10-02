'use strict';

// In-process HTTP helpers for route tests. NOT named *.test.js, so the
// `node --test test/*.test.js` glob won't try to run it as a test file.
// Same listen(0) + http.request pattern as test/server-library.test.js.

const http = require('node:http');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(port, method, path_, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = payload
      ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      : {};
    const req = http.request({ host: '127.0.0.1', port, path: path_, method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* ignore */ }
        resolve({ status: res.statusCode, json, body: buf });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Start the app, run fn(port), always close. */
async function withServer(app, fn) {
  const server = await listen(app);
  try {
    return await fn(server.address().port);
  } finally {
    server.close();
  }
}

module.exports = { listen, request, withServer };
