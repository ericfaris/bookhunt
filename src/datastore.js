'use strict';

// Durable JSON stores: history, watchlist, recipients, recipient groups,
// booktags, lists (radar state) and settings.
//
// Each store is a JSON file in the app dir (bind-mounted in Docker) that every
// read and write goes through, exactly as before. With DATA_STORE=mongo each
// write is ALSO mirrored to one document per store in MongoDB Atlas — the
// offsite copy that survives losing this machine (the ePUBs themselves already
// live in R2). Callers keep a synchronous API; the Atlas write happens in the
// background, coalesced (only the latest value per store is sent) and retried
// until it lands.
//
// Startup (init) reconciles each store before the app serves anything:
//   - Atlas copy newer than the local file, or no local file → restore locally
//     (disaster recovery: a rebuilt machine comes back with all its data);
//   - local file newer (an Atlas write failed before the last shutdown), or no
//     Atlas copy yet (first run) → push local up.
// Until a store has been reconciled, its writes are NOT pushed to Atlas: a
// half-started app with empty local files must never overwrite the good offsite
// copy. For the same reason init() refuses to start when Atlas is unreachable
// and a store's local file is missing — there is nothing safe to run on.
//
// Not mirrored: covers-cache.json (re-derivable lookup cache) uses this module
// for its hardened file I/O only.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_RETRY_MS = 60_000;
// An Atlas copy written within this window of the local file's mtime is the
// same write (the file is stamped with the Atlas time on restore).
const CLOCK_SLACK_MS = 1000;
const DOC_WARN_BYTES = 8 * 1024 * 1024; // Mongo's hard document limit is 16 MB

const stores = new Map();
let collection = null; // set by init() in mongo mode
const state = { mode: 'file', connected: false, lastError: null, lastFlushAt: null };
let retryTimer = null;

// --- hardened file I/O ---------------------------------------------------------

// The tmp copy lives in the OS temp dir, not beside the target. /app is
// root-owned in production (only the bind-mounted files themselves are writable
// by the uid-1000 process, not new files in that directory), so a tmp file
// created next to the target would fail with EACCES before we ever got to the
// rename/fallback logic. The name carries a hash of the full path: two stores
// (or two parallel test processes) with the same basename must never share a
// tmp copy, or one could rename the other's data into place.
function tmpPathFor(file) {
  const tag = crypto.createHash('sha1').update(path.resolve(file)).digest('hex').slice(0, 10);
  return path.join(os.tmpdir(), `${path.basename(file)}.${tag}.tmp`);
}

function isShape(value, shape) {
  if (shape === 'array') return Array.isArray(value);
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function emptyOf(shape) {
  return shape === 'array' ? [] : {};
}

// Read with recovery. A missing file returns the empty shape (first run). A file
// that EXISTS yet fails to parse is treated as a possibly-interrupted write: we
// try the tmp copy writeJsonFile leaves behind on a fallback-write interruption,
// restore it in place if it parses to the right shape, and only then fall back
// to empty — so a half-written target never silently empties a whole store.
function readJsonFile(file, shape = 'array') {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return emptyOf(shape); // ENOENT etc. — genuinely no file yet.
  }
  try {
    const data = JSON.parse(raw);
    return isShape(data, shape) ? data : emptyOf(shape);
  } catch {
    try {
      const tmp = JSON.parse(fs.readFileSync(tmpPathFor(file), 'utf8'));
      if (isShape(tmp, shape)) {
        fs.writeFileSync(file, JSON.stringify(tmp, null, 2), 'utf8');
        return tmp;
      }
    } catch {}
    return emptyOf(shape);
  }
}

// Hardened write. Atomic rename can fail on Docker bind mounts (each store is a
// single-file bind mount, so renameSync onto it throws EXDEV), so we write and
// verify a tmp copy first, try the atomic rename, and on ANY failure fall back
// to an in-place write + read-back verification, only unlinking the tmp copy
// once the target is confirmed good. If the fallback write or its verification
// throws, the tmp file is left behind as a recovery copy (readJsonFile restores
// it). Never replace the file via rename in production: swapping the inode
// desyncs the single-file bind mount.
function writeJsonFile(file, value) {
  const data = JSON.stringify(value, null, 2);
  const tmp = tmpPathFor(file);
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    const tmpBack = fs.readFileSync(tmp, 'utf8');
    JSON.parse(tmpBack);
    if (tmpBack.length !== data.length) throw new Error('tmp write verification failed');
    fs.renameSync(tmp, file); // atomic fast path (local dev / tests, same device as tmp)
    return data;
  } catch {
    // Fall through to the verified in-place write.
  }
  fs.writeFileSync(file, data, 'utf8');
  const back = fs.readFileSync(file, 'utf8');
  JSON.parse(back); // throws → surfaces as an error
  if (back.length !== data.length) throw new Error(`${path.basename(file)} write verification failed`);
  try { fs.unlinkSync(tmp); } catch {}
  return data;
}

// --- stores ----------------------------------------------------------------------

/**
 * Register a store. Re-defining a name replaces it (tests re-require modules
 * with a different file path). Returns { read, write, mutate }.
 */
function defineStore(name, { file, shape = 'array', mirror = true }) {
  const s = {
    name,
    file,
    shape,
    mirror,
    reconciled: false, // pushes to Atlas are held until init() has loaded this store
    pending: null, // { json, updatedAt } — latest value not yet in Atlas
    flushing: null, // in-flight drain promise
    gen: 0, // bumped on every write from this process (see signature())
  };
  stores.set(name, s);
  return {
    name,
    file,
    read: () => readJsonFile(s.file, s.shape),
    write: (value) => writeStore(s, value),
    /**
     * Cheap change token for memoizing values derived from this store: the
     * file's mtime + size (a stat, no read). Catches every writer, including a
     * background Atlas restore. Null when the file is missing.
     */
    signature() {
      try {
        const st = fs.statSync(s.file);
        return `${s.gen}:${st.mtimeMs}:${st.size}:${st.ino}`;
      } catch {
        return null;
      }
    },
    /**
     * Read-modify-write in ONE synchronous step against a FRESH read. `fn` may
     * mutate in place, return a replacement, or return false/null to abort.
     */
    mutate(fn) {
      const value = readJsonFile(s.file, s.shape);
      const out = fn(value);
      if (out === false || out === null) return value;
      const next = isShape(out, s.shape) ? out : value;
      writeStore(s, next);
      return next;
    },
  };
}

function writeStore(s, value) {
  const json = writeJsonFile(s.file, value);
  s.gen++;
  if (s.mirror && collection && s.reconciled) queueMirror(s, json, new Date());
  return value;
}

function queueMirror(s, json, updatedAt) {
  s.pending = { json, updatedAt };
  if (!s.flushing) s.flushing = drain(s).finally(() => { s.flushing = null; });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref());

// Send the latest pending value until none is left. A failure keeps the job
// (unless a newer one replaced it) and retries with backoff — a store's latest
// value always reaches Atlas once it is reachable again.
async function drain(s) {
  let backoff = 1000;
  while (s.pending) {
    const job = s.pending;
    s.pending = null;
    try {
      if (job.json.length > DOC_WARN_BYTES) {
        console.warn(`[datastore] "${s.name}" is ${(job.json.length / 1048576).toFixed(1)} MB — approaching Mongo's 16 MB document limit`);
      }
      await collection.replaceOne(
        { _id: s.name },
        { _id: s.name, data: JSON.parse(job.json), updatedAt: job.updatedAt, bytes: job.json.length },
        { upsert: true }
      );
      state.connected = true;
      state.lastError = null;
      state.lastFlushAt = new Date().toISOString();
      backoff = 1000;
    } catch (err) {
      if (!s.pending) s.pending = job;
      state.lastError = `${s.name}: ${err.message}`;
      console.warn(`[datastore] Atlas write failed for "${s.name}" (${err.message}) — retrying in ${backoff / 1000}s`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_RETRY_MS);
    }
  }
}

/** Bring one store in line with Atlas (see the header for the rules). */
async function reconcile(s) {
  const doc = await collection.findOne({ _id: s.name });
  let localMtime = null;
  try { localMtime = fs.statSync(s.file).mtimeMs; } catch { /* no local file */ }
  const atlasAt = doc && doc.updatedAt ? new Date(doc.updatedAt).getTime() : null;

  if (doc && (localMtime === null || atlasAt >= localMtime - CLOCK_SLACK_MS)) {
    const value = isShape(doc.data, s.shape) ? doc.data : emptyOf(s.shape);
    const json = JSON.stringify(value, null, 2);
    let current = null;
    try { current = fs.readFileSync(s.file, 'utf8'); } catch {}
    if (current !== json) {
      writeJsonFile(s.file, value);
      console.log(`[datastore] restored "${s.name}" from Atlas`);
    }
    // Stamp the file with the Atlas time so the next boot sees them as equal.
    try { fs.utimesSync(s.file, new Date(), new Date(atlasAt)); } catch {}
    s.reconciled = true;
    return 'restored';
  }
  s.reconciled = true;
  if (localMtime === null) return 'empty'; // nothing anywhere yet
  const value = readJsonFile(s.file, s.shape);
  queueMirror(s, JSON.stringify(value, null, 2), new Date(localMtime));
  return doc ? 'pushed-newer' : 'seeded';
}

async function reconcileAll() {
  const out = {};
  for (const s of stores.values()) {
    if (s.mirror && !s.reconciled) out[s.name] = await reconcile(s);
  }
  state.connected = true;
  state.lastError = null;
  return out;
}

/**
 * Validate config and connect. DATA_STORE=file (the default) leaves everything
 * local. DATA_STORE=mongo requires MONGODB_URI + MONGODB_DB (the error names
 * missing vars, never values). `client` is injectable for tests.
 * Resolves with the per-store reconcile outcome; throws when Atlas is
 * unreachable AND a mirrored store has no local file to run on.
 */
async function init(env = process.env, { client = null, timeoutMs = 15000 } = {}) {
  const mode = (env.DATA_STORE || 'file').toLowerCase();
  if (mode !== 'file' && mode !== 'mongo') throw new Error(`DATA_STORE must be "file" or "mongo" (got "${mode}")`);
  state.mode = mode;
  if (mode === 'file') return {};
  const missing = ['MONGODB_URI', 'MONGODB_DB'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`DATA_STORE=mongo but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not set`);

  if (!client) {
    const { MongoClient } = require('mongodb'); // lazy: file mode never loads the driver
    client = new MongoClient(env.MONGODB_URI, { appName: 'bookhunt', serverSelectionTimeoutMS: timeoutMs });
  }
  collection = client.db(env.MONGODB_DB).collection(env.MONGODB_COLLECTION || 'stores');
  try {
    await client.connect();
    return await reconcileAll();
  } catch (err) {
    state.connected = false;
    state.lastError = err.message;
    const noLocal = [...stores.values()].filter((s) => s.mirror && !s.reconciled && !fs.existsSync(s.file));
    if (noLocal.length) {
      throw new Error(
        `Atlas unreachable (${err.message}) and no local copy of ${noLocal.map((s) => s.name).join(', ')} — ` +
          'refusing to start empty (it would overwrite the Atlas copy)'
      );
    }
    console.error(`[datastore] Atlas unreachable at startup (${err.message}) — running on local files, retrying in background`);
    scheduleRetry();
    return null;
  }
}

function scheduleRetry(delay = 30_000) {
  if (retryTimer) return;
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    try {
      const out = await reconcileAll();
      console.log('[datastore] Atlas reachable again —', JSON.stringify(out));
    } catch (err) {
      state.lastError = err.message;
      scheduleRetry(Math.min(delay * 2, 10 * 60_000));
    }
  }, delay);
  retryTimer.unref();
}

/** Wait (bounded) for queued Atlas writes — called on shutdown. */
async function flush(timeoutMs = 5000) {
  const inflight = [...stores.values()].map((s) => s.flushing).filter(Boolean);
  if (!inflight.length) return true;
  const done = Promise.all(inflight).then(() => true);
  return Promise.race([done, sleep(timeoutMs).then(() => false)]);
}

/** Health summary for /api/status — never includes the URI. */
function status() {
  return {
    mode: state.mode,
    connected: state.mode === 'mongo' ? state.connected : null,
    pending: [...stores.values()].filter((s) => s.pending || s.flushing).map((s) => s.name),
    unreconciled: state.mode === 'mongo' ? [...stores.values()].filter((s) => s.mirror && !s.reconciled).map((s) => s.name) : [],
    lastError: state.lastError,
    lastFlushAt: state.lastFlushAt,
  };
}

/** Tests only: drop Atlas wiring and per-store state. */
function _reset() {
  collection = null;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  Object.assign(state, { mode: 'file', connected: false, lastError: null, lastFlushAt: null });
  for (const s of stores.values()) Object.assign(s, { reconciled: false, pending: null, flushing: null });
}

module.exports = {
  defineStore,
  init,
  flush,
  status,
  readJsonFile,
  writeJsonFile,
  tmpPathFor,
  _reset,
  _stores: stores,
};
