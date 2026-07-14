'use strict';

// Notification recipients, persisted to recipients.json (gitignored, bind-mounted
// in Docker). Shape: { id, name, email, kindleEmail?, phone?, carrier? }
//  - email      : where notifications go (required)
//  - kindleEmail: @kindle.com address; if set, Send also pushes the .epub there
//  - phone/carrier: reserved for the future Twilio SMS/MMS channel

const fs = require('fs');
const path = require('path');

// Overridable so tests can exercise the real read/mutate/write cycle against a
// temp file instead of the live recipients. Unset in production → the real files.
const FILE = process.env.RECIPIENTS_FILE || path.join(__dirname, '..', 'recipients.json');
const GROUPS_FILE = process.env.RECIPIENT_GROUPS_FILE || path.join(__dirname, '..', 'recipient-groups.json');

function readAll() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeAll(list) {
  writeJsonAtomic(FILE, list);
}

// Atomic-with-fallback JSON write, shared by recipients + groups. Atomic rename
// can fail on Docker bind-mounted volumes (WSL2), so fall back to a direct write.
function writeJsonAtomic(file, value) {
  const data = JSON.stringify(value, null, 2);
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, data, 'utf8');
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/**
 * Read-modify-write in ONE synchronous step, against a FRESH read of the file.
 *
 * Never do `const l = readAll(); await something(); writeAll(l);` — the snapshot
 * goes stale across the await and writing it back reverts every recipient added,
 * edited, or deleted in that window. Do the slow work (sending mail, resolving a
 * cover) first, then call mutate() with the result.
 *
 * `fn` receives the fresh list and may mutate it in place, return a replacement
 * array, or return false to abort without writing. Returns the persisted list.
 */
function mutate(fn) {
  const list = readAll();
  const out = fn(list);
  if (out === false || out === null) return list; // nothing to persist
  const next = Array.isArray(out) ? out : list;
  writeAll(next);
  return next;
}

// Cap field length so a hostile client can't bloat recipients.json, and cap the
// total number of recipients.
const MAX_LEN = 200;
const MAX_RECIPIENTS = 500;
// Deliberately conservative — one @, a dot in the domain, no spaces/control chars.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(s) {
  return typeof s === 'string' ? s.trim().slice(0, MAX_LEN) : '';
}

function add({ name, email, kindleEmail, phone, carrier }) {
  if (!clean(name)) throw new Error('Name is required');
  if (!clean(email)) throw new Error('Email is required');
  if (!EMAIL_RE.test(clean(email))) throw new Error('Email is not valid');
  if (clean(kindleEmail) && !EMAIL_RE.test(clean(kindleEmail))) {
    throw new Error('Kindle email is not valid');
  }
  const list = readAll();
  if (list.length >= MAX_RECIPIENTS) throw new Error('Too many recipients');
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: clean(name),
    email: clean(email),
    kindleEmail: clean(kindleEmail),
    phone: clean(phone),
    carrier: clean(carrier),
  };
  list.push(entry);
  writeAll(list);
  return entry;
}

function remove(id) {
  const list = readAll();
  const next = list.filter((r) => r.id !== id);
  writeAll(next);
  return next.length !== list.length;
}

function byIds(ids) {
  const set = new Set(ids || []);
  return readAll().filter((r) => set.has(r.id));
}

// --- Recipient groups (presets) --------------------------------------------
// A group is a named set of recipient ids — { id, name, recipientIds: [] } — so
// a common audience ("Family") can be selected in one click when sending.
const MAX_GROUPS = 100;

function readGroups() {
  try {
    const data = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeGroups(list) {
  writeJsonAtomic(GROUPS_FILE, list);
}

// PURE: validate + normalize group input. Throws on bad input. Dangling ids
// (recipients later deleted) are tolerated here and filtered at expand time.
function cleanGroupInput({ name, recipientIds }) {
  const n = clean(name);
  if (!n) throw new Error('Group name is required');
  if (!Array.isArray(recipientIds)) throw new Error('recipientIds must be an array');
  const ids = [...new Set(recipientIds.filter((x) => typeof x === 'string' && x))].slice(0, MAX_RECIPIENTS);
  if (!ids.length) throw new Error('Pick at least one recipient for the group');
  return { name: n, recipientIds: ids };
}

function addGroup({ name, recipientIds }) {
  const cleaned = cleanGroupInput({ name, recipientIds });
  const list = readGroups();
  if (list.length >= MAX_GROUPS) throw new Error('Too many groups');
  const entry = {
    id: 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ...cleaned,
  };
  list.push(entry);
  writeGroups(list);
  return entry;
}

function removeGroup(id) {
  const list = readGroups();
  const next = list.filter((g) => g.id !== id);
  writeGroups(next);
  return next.length !== list.length;
}

module.exports = {
  readAll, writeAll, mutate, add, remove, byIds,
  readGroups, addGroup, removeGroup, cleanGroupInput,
};
