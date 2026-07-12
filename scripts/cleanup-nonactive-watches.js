#!/usr/bin/env node
'use strict';

// ONE-OFF DATA CLEANUP — run manually, once, on the host.
//
// Removes every entry from watchlist.json whose status is not 'active'
// (all fulfilled/paused/expired entries), after taking a timestamped backup.
//
// This script is INTENTIONALLY not referenced by package.json, the server
// (src/server.js), the watcher (src/watcher.js), or any scheduler/cron. It is
// not recurring behavior — do NOT wire it in. It exists in the repo only for
// auditability. Run it by hand with `node scripts/cleanup-nonactive-watches.js`.
//
// Everything is synchronous and fail-fast: if the file is missing, unreadable,
// or doesn't parse to an array, it aborts with a non-zero exit and touches
// nothing. The backup is taken BEFORE any destructive write; if the backup copy
// fails, it aborts. The write is a plain in-place writeFileSync — NEVER a rename
// — so the host-side inode is preserved and the running container's single-file
// bind mount keeps seeing the same file (the lists.json bind-mount inode gotcha).

const fs = require('fs');
const path = require('path');

function main() {
  const file = process.argv[2] || path.join(__dirname, '..', 'watchlist.json');

  let list;
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`ABORT: could not read/parse ${file}: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(list)) {
    console.error(`ABORT: ${file} is not a JSON array.`);
    process.exit(1);
  }

  // Before report.
  const before = {};
  for (const w of list) {
    const s = w && w.status ? w.status : '(none)';
    before[s] = (before[s] || 0) + 1;
  }

  // Back up FIRST — abort if the copy fails (no backup, no cleanup).
  const stamp = new Date().toISOString().replace(/:/g, '-');
  const backup = `${file}.bak-${stamp}`;
  try {
    fs.copyFileSync(file, backup);
  } catch (err) {
    console.error(`ABORT: backup copy failed (${err.message}); no changes made.`);
    process.exit(1);
  }

  const kept = list.filter((w) => w && w.status === 'active');

  // In-place write — never via rename (preserves the bind-mount inode).
  fs.writeFileSync(file, JSON.stringify(kept, null, 2), 'utf8');

  console.log(`File:          ${file}`);
  console.log(`Backup:        ${backup}`);
  console.log(`Total before:  ${list.length}`);
  console.log(`By status:     ${JSON.stringify(before)}`);
  console.log(`Total after:   ${kept.length} (all status: 'active')`);
  console.log(`Removed:       ${list.length - kept.length}`);
  process.exit(0);
}

main();
