#!/usr/bin/env node
'use strict';

// ONE-OFF: email shelf readers about the tap-a-book details modal.
//
// DRY RUN BY DEFAULT — lists who would get it and writes an HTML preview; it
// sends nothing and stamps nothing. Run inside the container (so it sees the
// live recipients.json + R2 library):
//
//   docker compose exec bookhunt node scripts/announce-book-details.js                 # dry run + preview
//   docker compose exec bookhunt node scripts/announce-book-details.js --only <id|email> --send   # test to one
//   docker compose exec bookhunt node scripts/announce-book-details.js --send          # everyone
//
// Idempotent: each recipient is stamped readerAnnouncements[<id>] after a
// successful send, so re-running only reaches readers not yet emailed.
// Readers who stopped BookHunt emails are skipped.

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const reader = require('../src/reader');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] || null;
}

async function main() {
  const send = process.argv.includes('--send');
  const only = arg('--only');
  const out = await reader.announceBookDetails({ send, only });

  console.log(`${out.dryRun ? 'DRY RUN' : 'SEND'} — announcement "${out.id}"`);
  console.log(`Featured book: ${out.sample ? `${out.sample.title} — ${out.sample.author}` : '(none — generic card)'}`);
  console.log(`Recipients (${out.targets.length}):`);
  for (const t of out.targets) console.log(`  • ${t.name} <${t.email}>`);

  if (out.dryRun) {
    // Placeholder token: never write a reader's real magic link into a temp file.
    const who = { name: (out.targets[0] || {}).name || 'Reader', readerToken: 'PREVIEW_TOKEN' };
    const msg = reader.buildBookDetailsAnnouncement(who, out.sample);
    // Preview: CID covers won't resolve in a browser, so point them at the URL.
    const html = msg.html.replace(/cid:feature-cover@book/g, out.sample ? out.sample.cover : '');
    const file = arg('--preview') || path.join(require('os').tmpdir(), 'bookhunt-announce-preview.html');
    fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>${msg.subject}</title>${html}`);
    console.log(`\nSubject: ${msg.subject}\nPreview written to ${file}\nNothing sent. Re-run with --send to email.`);
    return;
  }
  console.log(`\nSent: ${out.sent.length}`);
  for (const f of out.failed) console.log(`  ✖ ${f.email}: ${f.error}`);
  if (out.failed.length) process.exitCode = 1;
}

main().catch((err) => { console.error('ABORT:', err.message); process.exit(1); });
