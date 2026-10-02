'use strict';

// AC5 (issue #47): STORAGE=r2 with required R2_* vars missing must fail fast —
// exit 1 with a clear message naming the missing vars, BEFORE the server
// listens or the browser launches. Spawns the real entry point from a temp
// cwd (so dotenv finds no .env) with a minimal env (no real credentials).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { test } = require('node:test');
const assert = require('node:assert');

const SERVER = path.join(__dirname, '..', 'src', 'server.js');

function run(env) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-startup-'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd,
      env: { PATH: process.env.PATH, HOME: cwd, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server did not exit within 10s\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 10000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('startup: STORAGE=r2 with missing R2 vars exits 1 with a clear message, never listening', { timeout: 15000 }, async () => {
  const { code, stdout, stderr } = await run({
    STORAGE: 'r2',
    R2_ACCOUNT_ID: '',
    R2_ACCESS_KEY_ID: 'AKID-not-real',
    R2_SECRET_ACCESS_KEY: 'SEKRET-not-real',
    R2_BUCKET: '',
    PORT: '0',
  });
  assert.equal(code, 1);
  assert.match(stderr, /STORAGE=r2 but required env var\(s\) are missing/);
  assert.match(stderr, /R2_BUCKET/);
  assert.match(stderr, /R2_ACCOUNT_ID/);
  assert.ok(!/R2_SECRET_ACCESS_KEY/.test(stderr), 'only missing vars are named');
  assert.ok(!stderr.includes('SEKRET-not-real') && !stdout.includes('SEKRET-not-real'), 'never echoes a secret');
  assert.ok(!stdout.includes('BookHunt running'), 'never started listening');
});

test('startup: an unknown STORAGE value exits 1', { timeout: 15000 }, async () => {
  const { code, stdout, stderr } = await run({ STORAGE: 's3', PORT: '0' });
  assert.equal(code, 1);
  assert.match(stderr, /Unknown STORAGE/);
  assert.ok(!stdout.includes('BookHunt running'));
});

test('startRefreshTimer: periodic refresh failures are swallowed (logged), successes refresh the index', { timeout: 5000 }, async () => {
  const storage = require('../src/storage');
  const { createFakeS3 } = require('./fake-s3');
  const fake = createFakeS3();
  fake.seed('books/a.epub', 'a');
  const driver = storage.createR2Driver({ root: '/dl', bucket: 'b', client: fake, stagingRoot: os.tmpdir() });
  storage._setDriver(driver);
  const origErr = console.error;
  const logged = [];
  console.error = (...a) => { logged.push(a.join(' ')); };
  try {
    fake.failNext('ListObjectsV2Command', new Error('flaky'));
    storage.startRefreshTimer(20);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !(driver.healthInfo().indexLoaded && logged.length)) {
      await new Promise((r) => setTimeout(r, 10));
    }
  } finally {
    console.error = origErr;
    storage._reset();
  }
  assert.ok(logged.some((l) => l.includes('R2 index refresh failed: flaky')));
  assert.equal(driver.healthInfo().indexLoaded, true, 'a later tick recovered');
  assert.equal(driver.healthInfo().lastError, null);
});
