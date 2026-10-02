#!/usr/bin/env node
'use strict';

// ONE-OFF LIBRARY MIGRATION (issue #47) — run manually, on the host.
//
// Copies the existing local epub library up to the Cloudflare R2 bucket
// (key `books/<filename>`), so STORAGE=r2 can be switched on afterwards.
//
//   node scripts/migrate-to-r2.js                  # DRY RUN (default): plan only, writes nothing
//   node scripts/migrate-to-r2.js --apply          # upload, then verify every object
//   node scripts/migrate-to-r2.js --src /mnt/c/epubs [--apply]
//
// --src defaults to DOWNLOAD_PATH from the environment/.env. R2 credentials
// (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET) come from
// .env and are required regardless of STORAGE.
//
// Safety:
//  - Dry run is the default and makes ONLY read-only list calls.
//  - Local files are opened read-only; this script NEVER deletes, moves or
//    modifies anything on local disk (the local library stays as the backup),
//    and never deletes anything in the bucket.
//  - Idempotent: objects already present with the same size are skipped, so
//    a re-run only uploads what's missing (a size mismatch is re-uploaded).
//  - Uploads send Content-MD5 (R2 rejects corrupted bodies); --apply then
//    re-lists the bucket and checks every object's size and, for single-part
//    uploads, its ETag against the local MD5.
//  - Prints the bucket name only — never credentials, the account id or the
//    endpoint.
//
// This script is INTENTIONALLY not referenced by package.json, the server or
// any scheduler — do NOT wire it in. Note: `scripts/` is not copied into the
// Docker image, so run it on the host after `npm install`.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const storage = require('../src/storage');

const USAGE = 'Usage: node scripts/migrate-to-r2.js [--apply] [--src <dir>] [--help]';
const EPUB_RE = /\.epub$/i;

function md5hex(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

/** PURE: parse CLI args. Throws on an unknown argument. */
function parseArgs(argv) {
  const out = { apply: false, src: null, help: false };
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--src') {
      if (!args[i + 1]) throw new Error('--src needs a directory');
      out.src = args[++i];
    } else if (a.startsWith('--src=')) out.src = a.slice('--src='.length);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

/**
 * Plan (and with apply=true, perform + verify) the upload of every local
 * .epub in srcDir. `driver` is an r2 storage driver rooted at srcDir.
 * Returns { planned, skipped, uploaded, replaced, failed, verified, mismatched, ignored }.
 */
async function migrate({ srcDir, driver, apply = false, log = console.log }) {
  // 1. Local scan (read-only).
  const local = [];
  const ignored = [];
  for (const d of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!d.isFile()) continue;
    const file = path.join(srcDir, d.name);
    const key = EPUB_RE.test(d.name) ? storage.keyFor(file, srcDir) : null;
    if (!key) { ignored.push(d.name); continue; }
    local.push({ name: d.name, file, key, size: fs.statSync(file).size });
  }
  local.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const localBytes = local.reduce((n, f) => n + f.size, 0);

  log(`Source: ${srcDir}`);
  log(`Bucket: ${driver.bucket} (prefix ${storage.PREFIX})`);
  log(`Mode:   ${apply ? 'APPLY' : 'DRY RUN'}`);

  // 2. One paginated listing of what's already in the bucket.
  await driver.refresh();

  // 3. Plan.
  const toUpload = [];
  const toReplace = [];
  const skipped = [];
  for (const f of local) {
    const remote = driver.index.get(f.key);
    if (remote && remote.size === f.size) skipped.push(f);
    else if (remote) toReplace.push(f);
    else toUpload.push(f);
  }
  for (const name of ignored) log(`  ignore   ${name}`);
  for (const f of toUpload) log(`  upload   ${f.name} (${fmtBytes(f.size)})`);
  for (const f of toReplace) log(`  replace  ${f.name} (${fmtBytes(f.size)}; size differs in bucket)`);

  const result = {
    planned: toUpload.length + toReplace.length,
    skipped: skipped.length,
    uploaded: 0,
    replaced: 0,
    failed: 0,
    verified: 0,
    mismatched: 0,
    ignored: ignored.length,
  };

  const summary = (extra = []) => {
    log('');
    log(`local epubs:               ${local.length} (${fmtBytes(localBytes)})`);
    log(`ignored:                   ${result.ignored}`);
    log(`already present (skipped): ${result.skipped}`);
    log(`to upload:                 ${result.planned}`);
    for (const line of extra) log(line);
  };

  if (!apply) {
    summary();
    log('');
    log('DRY RUN — nothing written. Re-run with --apply to upload.');
    return result;
  }

  // 4. Upload (per-file failures are counted and skipped, never fatal).
  for (const [f, kind] of [...toUpload.map((f) => [f, 'upload']), ...toReplace.map((f) => [f, 'replace'])]) {
    try {
      const buf = fs.readFileSync(f.file);
      await driver.putBuffer(buf, f.file);
      if (kind === 'upload') result.uploaded++;
      else result.replaced++;
      log(`  ok       ${f.name}`);
    } catch (err) {
      result.failed++;
      log(`  FAILED   ${f.name}: ${(err && err.message) || err}`);
    }
  }

  // 5. Verify against a fresh listing.
  await driver.refresh();
  let remoteBytes = 0;
  for (const f of local) {
    const remote = driver.index.get(f.key);
    if (!remote || remote.size !== f.size) {
      result.mismatched++;
      log(`  MISMATCH ${f.name}: ${remote ? `size ${remote.size} != ${f.size}` : 'missing in bucket'}`);
      continue;
    }
    remoteBytes += remote.size;
    const etag = String(remote.etag || '').toLowerCase();
    if (etag && !etag.includes('-') && etag !== md5hex(fs.readFileSync(f.file))) {
      result.mismatched++;
      log(`  MISMATCH ${f.name}: checksum differs`);
      continue;
    }
    result.verified++;
  }

  summary([
    `uploaded:                  ${result.uploaded}`,
    `replaced:                  ${result.replaced}`,
    `failed:                    ${result.failed}`,
    `verified OK:               ${result.verified}`,
    `verify mismatches:         ${result.mismatched}`,
    `bytes local / in bucket:   ${fmtBytes(localBytes)} / ${fmtBytes(remoteBytes)}`,
  ]);
  return result;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  require('dotenv').config();

  const srcDir = args.src || process.env.DOWNLOAD_PATH;
  if (!srcDir) {
    console.error('No source directory — pass --src <dir> or set DOWNLOAD_PATH.');
    process.exit(2);
  }
  try {
    if (!fs.statSync(srcDir).isDirectory()) throw new Error('not a directory');
    fs.accessSync(srcDir, fs.constants.R_OK);
  } catch (err) {
    console.error(`Cannot read source directory ${srcDir}: ${err.message}`);
    process.exit(2);
  }

  let cfg;
  try {
    cfg = storage.r2ConfigFromEnv(process.env);
  } catch (err) {
    console.error(`R2 is not configured — ${err.message}`);
    process.exit(2);
  }
  const driver = storage.createR2Driver({ root: srcDir, ...cfg });
  const res = await migrate({ srcDir, driver, apply: args.apply });
  process.exit(res.failed || res.mismatched ? 1 : 0);
}

module.exports = { migrate, parseArgs };

if (require.main === module) {
  main().catch((err) => {
    console.error(`Migration failed: ${(err && err.message) || err}`);
    process.exit(1);
  });
}
