'use strict';

// Notification recipients, persisted to recipients.json (gitignored, bind-mounted
// in Docker). Shape: { id, name, email, kindleEmail?, phone?, carrier? }
//  - email      : where notifications go (required)
//  - kindleEmail: @kindle.com address; if set, Send also pushes the .epub there
//  - phone/carrier: reserved for the future Twilio SMS/MMS channel

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'recipients.json');

function readAll() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeAll(list) {
  const data = JSON.stringify(list, null, 2);
  const tmp = FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, FILE);
  } catch {
    // Atomic rename fails on Docker bind-mounted files (WSL2 filesystem).
    fs.writeFileSync(FILE, data, 'utf8');
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function clean(s) {
  return typeof s === 'string' ? s.trim() : '';
}

function add({ name, email, kindleEmail, phone, carrier }) {
  if (!clean(name)) throw new Error('Name is required');
  if (!clean(email)) throw new Error('Email is required');
  const list = readAll();
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

module.exports = { readAll, add, remove, byIds };
