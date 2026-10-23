'use strict';

// DOWNLOAD_PATH default: the repo's ./downloads (it used to be the Windows-only
// 'C:\temp', which on Linux created a folder literally named "C:\temp").

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const probe = (env) => execFileSync(process.execPath, ['-e', "process.stdout.write(require('./src/downloader').DOWNLOAD_PATH)"], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, STORAGE: 'local', ...env },
}).toString();

test('DOWNLOAD_PATH: unset → <repo>/downloads', () => {
  const env = { ...process.env };
  delete env.DOWNLOAD_PATH;
  const out = execFileSync(process.execPath, ['-e', "process.stdout.write(require('./src/downloader').DOWNLOAD_PATH)"], {
    cwd: path.join(__dirname, '..'), env: { ...env, STORAGE: 'local' },
  }).toString();
  assert.equal(out, path.join(__dirname, '..', 'downloads'));
  assert.ok(!out.includes('C:'), 'no Windows path');
});

test('DOWNLOAD_PATH: env wins (docker-compose sets /downloads)', () => {
  assert.equal(probe({ DOWNLOAD_PATH: '/downloads' }), '/downloads');
});
