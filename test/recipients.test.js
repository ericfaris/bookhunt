'use strict';

// update() tests use REAL files (via the RECIPIENTS_FILE seam, set before the
// module is required) — the whole point of update() is preserving id +
// readerToken across a real read-modify-write, so stubbing the store would
// test nothing.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bookhunt-recip-update-'));
process.env.RECIPIENTS_FILE = path.join(TMP, 'recipients.json');

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

test('recipients.add: rejects a malformed email', () => {
  assert.throws(() => recipients.add({ name: 'Alice', email: 'not-an-email' }), /not valid/i);
  assert.throws(() => recipients.add({ name: 'Alice', email: 'a@b' }), /not valid/i);
});

test('recipients.add: rejects a malformed kindle email', () => {
  assert.throws(
    () => recipients.add({ name: 'Alice', email: 'a@b.com', kindleEmail: 'bogus' }),
    /kindle email is not valid/i
  );
});

// cleanGroupInput validates BEFORE any file I/O, so these are safe to run
// without touching recipient-groups.json.
test('cleanGroupInput: requires a name', () => {
  assert.throws(() => recipients.cleanGroupInput({ recipientIds: ['a'] }), /name/i);
  assert.throws(() => recipients.cleanGroupInput({ name: '  ', recipientIds: ['a'] }), /name/i);
});

test('cleanGroupInput: requires a non-empty recipientIds array', () => {
  assert.throws(() => recipients.cleanGroupInput({ name: 'Family' }), /array/i);
  assert.throws(() => recipients.cleanGroupInput({ name: 'Family', recipientIds: [] }), /at least one/i);
});

test('cleanGroupInput: de-dupes ids and drops non-strings', () => {
  const out = recipients.cleanGroupInput({ name: '  Family  ', recipientIds: ['a', 'a', 'b', 5, null, ''] });
  assert.equal(out.name, 'Family');
  assert.deepEqual(out.recipientIds, ['a', 'b']);
});

// --- recipients.update -------------------------------------------------------
// Issue #7: editing must happen IN PLACE. Delete + re-add mints a new id and
// readerToken, breaking the recipient's magic link, their installed home-
// screen app, and every watch's recipientIds pointing at the old id.

function resetRecipients(list = []) {
  fs.writeFileSync(process.env.RECIPIENTS_FILE, JSON.stringify(list, null, 2));
}

test('recipients.update: preserves id and readerToken while changing other fields', () => {
  resetRecipients([]);
  const r = recipients.add({ name: 'Bob', email: 'bob@example.com' });
  // Simulate a minted reader token (normally set by reader.ensureToken).
  recipients.mutate((list) => {
    list.find((x) => x.id === r.id).readerToken = 'secret-token-abc';
  });

  const updated = recipients.update(r.id, { name: 'Bobby', kindleEmail: 'bob@kindle.com' });
  assert.equal(updated.id, r.id, 'id must never change');
  assert.equal(updated.readerToken, 'secret-token-abc', 'readerToken must survive an edit');
  assert.equal(updated.name, 'Bobby');
  assert.equal(updated.kindleEmail, 'bob@kindle.com');
  assert.equal(updated.email, 'bob@example.com', 'untouched field stays as-is');

  // And it's actually persisted, not just returned.
  const reread = recipients.readAll().find((x) => x.id === r.id);
  assert.equal(reread.name, 'Bobby');
  assert.equal(reread.readerToken, 'secret-token-abc');
});

test('recipients.update: validates email same as add()', () => {
  resetRecipients([]);
  const r = recipients.add({ name: 'Cara', email: 'cara@example.com' });
  assert.throws(() => recipients.update(r.id, { email: 'not-an-email' }), /not valid/i);
  assert.throws(() => recipients.update(r.id, { email: '' }), /required/i);
  assert.throws(() => recipients.update(r.id, { kindleEmail: 'bogus' }), /kindle email is not valid/i);
  // A rejected update must not have touched the stored record.
  assert.equal(recipients.readAll().find((x) => x.id === r.id).email, 'cara@example.com');
});

test('recipients.update: rejects an unknown id (returns null, no throw)', () => {
  resetRecipients([]);
  recipients.add({ name: 'Dana', email: 'dana@example.com' });
  const result = recipients.update('nonexistent-id', { name: 'New Name' });
  assert.equal(result, null);
});

test('recipients.update: caller cannot smuggle in id/readerToken/readerEnabled changes', () => {
  resetRecipients([]);
  const r = recipients.add({ name: 'Eve', email: 'eve@example.com' });
  recipients.mutate((list) => {
    const x = list.find((y) => y.id === r.id);
    x.readerToken = 'orig-token';
    x.readerEnabled = true;
  });
  const updated = recipients.update(r.id, { id: 'hacked-id', readerToken: 'hacked-token', readerEnabled: false, name: 'Eve 2' });
  assert.equal(updated.id, r.id);
  assert.equal(updated.readerToken, 'orig-token');
  assert.equal(updated.readerEnabled, true);
  assert.equal(updated.name, 'Eve 2'); // legitimate field still applies
});

test('recipients.update: only touches fields present in the patch', () => {
  resetRecipients([]);
  const r = recipients.add({ name: 'Finn', email: 'finn@example.com', phone: '+15551234', carrier: 'verizon' });
  const updated = recipients.update(r.id, { name: 'Finn Two' });
  assert.equal(updated.phone, '+15551234', 'untouched field preserved');
  assert.equal(updated.carrier, 'verizon', 'untouched field preserved');
});
