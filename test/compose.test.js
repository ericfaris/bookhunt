'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const COMPOSE = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');

// Books live only in R2 (issue #47) and the container has no books volume, so a
// `local` fallback would silently write books into ephemeral container storage.
test('docker-compose: STORAGE defaults to r2', () => {
  const m = COMPOSE.match(/^\s*-\s*STORAGE=\$\{STORAGE:-(\w+)\}\s*$/m);
  assert.ok(m, 'STORAGE passthrough missing from docker-compose.yml');
  assert.equal(m[1], 'r2');
});

test('docker-compose: DATA_STORE defaults to mongo and passes MONGODB_* through', () => {
  const m = COMPOSE.match(/^\s*-\s*DATA_STORE=\$\{DATA_STORE:-(\w+)\}\s*$/m);
  assert.ok(m, 'DATA_STORE passthrough missing from docker-compose.yml');
  assert.equal(m[1], 'mongo');
  for (const v of ['MONGODB_URI', 'MONGODB_DB']) {
    assert.match(COMPOSE, new RegExp(`^\\s*-\\s*${v}=\\$\\{${v}:-\\}\\s*$`, 'm'), `${v} passthrough missing`);
  }
});
