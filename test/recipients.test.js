'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const recipients = require('../src/recipients');

// add() validates name+email BEFORE any file I/O, so these throw cases are
// safe to run without touching recipients.json.
test('recipients.add: requires a name', () => {
  assert.throws(() => recipients.add({ email: 'a@b.com' }), /name/i);
});

test('recipients.add: requires an email', () => {
  assert.throws(() => recipients.add({ name: 'Alice' }), /email/i);
  assert.throws(() => recipients.add({ name: 'Alice', email: '   ' }), /email/i);
});
