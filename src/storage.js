'use strict';

// Book-file storage (issue #47): where the downloaded .epub files actually live.
//
// Two drivers behind one interface, picked by STORAGE=local|r2 (unset = local):
//
//  - local: today's behaviour, verbatim — books are plain files in
//    DOWNLOAD_PATH (the /mnt/c/epubs bind mount in Docker). This is the default
//    and must stay byte-for-byte identical to the pre-#47 code paths.
//  - r2: books live in a private Cloudflare R2 bucket under `books/<basename>`,
//    spoken to via the S3 API (@aws-sdk/client-s3, required lazily so local
//    mode never loads the SDK).
//
// Book IDENTITY never changes: history.json / booktags.json keep keying on the
// logical savePath (`/downloads/<name>.epub`), and this module maps that path
// to an object key internally. So nothing persisted is rewritten, and rolling
// back is just flipping STORAGE back to local.
//
// The Library renders synchronously per book (`buildLibrary(entries,
// fileExists)`), so existence in r2 mode is answered from an in-memory key
// index built from ONE paginated ListObjectsV2 — never a HEAD per book. Async
// entry points `await store.ensureIndex()` first (at most one list, shared by
// concurrent callers), then call the sync `existsSync`. Uploads/deletes made
// by this process update the index in place; a periodic refresh picks up
// changes made elsewhere.
//
// Secrets: nothing here ever logs or returns credential values, the account
// id or the endpoint. Errors carry `err.message` only.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const health = require('./health');

const PREFIX = 'books/';
// Same book/archive set the downloader recognizes (FILE_EXT_RE in
// downloader.js): runMirrors may keep an unverified non-epub fallback, and r2
// mode must be able to store whatever local mode would have kept.
const BOOK_EXT_RE = /\.(epub|mobi|azw|azw3|pdf|txt|cbz|cbr|zip|rar|7z)$/i;
// MUST match downloader.js's DOWNLOAD_PATH default so the storage root always
// equals the downloader's (storage can't require downloader — that's a cycle).
const DEFAULT_DOWNLOAD_PATH = 'C:\\temp';
const R2_REQUIRED_VARS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
const MAX_KEY_NAME_BYTES = 1000;

class StorageConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StorageConfigError';
  }
}

// --- pure helpers ------------------------------------------------------------

/** PURE: is this a basename we're willing to turn into an object key? */
function isValidBookName(base) {
  if (!base || typeof base !== 'string') return false;
  if (base.startsWith('.')) return false;
  if (/[/\\\u0000-\u001f]/.test(base)) return false;
  if (Buffer.byteLength(base) > MAX_KEY_NAME_BYTES) return false;
  return BOOK_EXT_RE.test(base);
}

/**
 * PURE: map a logical savePath to its object key (`books/<basename>`), or null
 * when the path isn't DIRECTLY inside `root` (no subdirs, no traversal), or its
 * basename is empty / dot-leading / has slashes or control chars / isn't a
 * book or archive extension.
 */
function keyFor(savePath, root) {
  if (!savePath || !root) return null;
  const r = path.resolve(root);
  const p = path.resolve(String(savePath));
  if (path.dirname(p) !== r) return null;
  const base = path.basename(p);
  if (!isValidBookName(base)) return null;
  return PREFIX + base;
}

/** PURE: inverse of keyFor — the logical savePath for a key, or null. */
function savePathForKey(key, root) {
  if (!key || !root) return null;
  const k = String(key);
  if (!k.startsWith(PREFIX)) return null;
  const base = k.slice(PREFIX.length);
  if (base.includes('/')) return null;
  if (!isValidBookName(base)) return null;
  return path.join(root, base);
}

function stripQuotes(etag) {
  return etag ? String(etag).replace(/^"+|"+$/g, '') : null;
}

function contentTypeFor(name) {
  if (/\.epub$/i.test(name)) return 'application/epub+zip';
  if (/\.pdf$/i.test(name)) return 'application/pdf';
  return 'application/octet-stream';
}

/**
 * PURE: the R2 part of the config. Throws a StorageConfigError naming ONLY the
 * missing variable names — never any value. Used by configFromEnv and by the
 * migration script (which needs R2 regardless of STORAGE).
 */
function r2ConfigFromEnv(env = {}) {
  const val = (k) => String(env[k] == null ? '' : env[k]).trim();
  const missing = R2_REQUIRED_VARS.filter((k) => !val(k)).sort();
  if (missing.length) {
    throw new StorageConfigError(
      `STORAGE=r2 but required env var(s) are missing: ${missing.join(', ')} (see .env.example)`
    );
  }
  return {
    accountId: val('R2_ACCOUNT_ID'),
    accessKeyId: val('R2_ACCESS_KEY_ID'),
    secretAccessKey: val('R2_SECRET_ACCESS_KEY'),
    bucket: val('R2_BUCKET'),
  };
}

/** PURE: resolve the storage config from an env object, or throw. */
function configFromEnv(env = {}) {
  const root = env.DOWNLOAD_PATH || DEFAULT_DOWNLOAD_PATH;
  const mode = String(env.STORAGE == null ? '' : env.STORAGE).trim().toLowerCase();
  if (!mode || mode === 'local') return { mode: 'local', root };
  if (mode === 'r2') {
    return {
      mode: 'r2',
      root,
      ...r2ConfigFromEnv(env),
      stagingRoot: String(env.STORAGE_STAGING_DIR || '').trim() || undefined,
    };
  }
  throw new StorageConfigError(`Unknown STORAGE "${String(env.STORAGE).slice(0, 20)}" — use "local" or "r2"`);
}

// --- local driver ------------------------------------------------------------
// Wraps today's fs behaviour. Existence and remove are deliberately UNSCOPED
// (any path), exactly like the original call sites; only put* validates keys.

function createLocalDriver({ root = DEFAULT_DOWNLOAD_PATH } = {}) {
  const rawRoot = root; // unresolved, so path.join results match downloader's
  const rootAbs = path.resolve(root);

  function requireKey(savePath, verb) {
    const key = keyFor(savePath, rootAbs);
    if (!key) throw new Error(`Refusing to ${verb} ${path.basename(String(savePath || ''))}: not a valid book path`);
    return key;
  }

  return {
    mode: 'local',
    root: rootAbs,
    stagingDir: () => rawRoot,
    existsSync(savePath) {
      try {
        return fs.existsSync(path.resolve(savePath));
      } catch {
        return false;
      }
    },
    ensureIndex: async () => {},
    refresh: async () => {},
    async putFile(srcPath, savePath) {
      requireKey(savePath, 'store');
      if (path.resolve(srcPath) === path.resolve(savePath)) return;
      fs.copyFileSync(srcPath, path.resolve(savePath));
    },
    async putBuffer(buf, savePath) {
      requireKey(savePath, 'store');
      fs.writeFileSync(path.resolve(savePath), buf);
    },
    getBuffer: (savePath) => fs.promises.readFile(path.resolve(savePath)),
    async remove(savePath) {
      const abs = path.resolve(savePath);
      if (fs.existsSync(abs)) {
        fs.unlinkSync(abs); // errors propagate, as the original delete route logs them
        return true;
      }
      return false;
    },
    async list() {
      const out = [];
      for (const d of fs.readdirSync(rawRoot, { withFileTypes: true })) {
        if (!d.isFile()) continue;
        const savePath = path.join(rawRoot, d.name);
        const key = keyFor(savePath, rootAbs);
        if (!key) continue;
        let size = 0;
        try { size = fs.statSync(savePath).size; } catch { /* ignore */ }
        out.push({ name: d.name, key, size, savePath });
      }
      return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    stats: async () => health.readDownloadStats(rawRoot),
    disk: () => health.freeSpace(rawRoot),
    attachment: async (savePath) => ({ filePath: savePath }),
    healthInfo: () => ({ mode: 'local', ok: true }),
    displayPath: () => rawRoot,
  };
}

// --- r2 driver ---------------------------------------------------------------

function createR2Driver({
  root = DEFAULT_DOWNLOAD_PATH,
  bucket,
  accountId,
  accessKeyId,
  secretAccessKey,
  client,
  stagingRoot,
} = {}) {
  if (!bucket) throw new StorageConfigError('R2 driver needs a bucket name');
  // Lazy: local mode never loads the SDK. The command classes construct
  // offline, so an injected test client still receives real command objects.
  const sdk = require('@aws-sdk/client-s3');
  const s3 =
    client ||
    new sdk.S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
      // Newer SDK v3 checksum defaults send headers R2 rejects; only compute /
      // validate checksums when an operation actually requires them.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });

  const rawRoot = root;
  const rootAbs = path.resolve(root);
  let index = new Map(); // key -> { size, etag, lastModified }
  let indexLoaded = false;
  let lastRefreshAt = null;
  let lastError = null;
  let inflight = null; // shared refresh promise
  let pending = null; // mutations recorded while a refresh is in flight

  function requireKey(savePath, verb) {
    const key = keyFor(savePath, rootAbs);
    if (!key) throw new Error(`Refusing to ${verb} ${path.basename(String(savePath || ''))}: not a valid book path`);
    return key;
  }

  function applyMutation(map, m) {
    if (m.op === 'put') map.set(m.key, m.meta);
    else map.delete(m.key);
  }

  // Apply now, and remember it if a refresh is mid-flight so the list result
  // (which may predate this mutation) can't erase it when it swaps in.
  function recordMutation(m) {
    applyMutation(index, m);
    if (pending) pending.push(m);
  }

  async function listAll() {
    pending = [];
    try {
      const next = new Map();
      let token;
      do {
        const resp = await s3.send(
          new sdk.ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX, ContinuationToken: token })
        );
        for (const o of (resp && resp.Contents) || []) {
          if (!o || !o.Key) continue;
          next.set(o.Key, {
            size: Number(o.Size) || 0,
            etag: stripQuotes(o.ETag),
            lastModified: o.LastModified ? new Date(o.LastModified).toISOString() : null,
          });
        }
        token = resp && resp.IsTruncated ? resp.NextContinuationToken : undefined;
      } while (token);
      for (const m of pending) applyMutation(next, m);
      index = next;
      indexLoaded = true;
      lastRefreshAt = new Date().toISOString();
      lastError = null;
    } catch (err) {
      lastError = (err && err.message) || String(err);
      throw err;
    } finally {
      pending = null;
    }
  }

  /** One paginated list → fresh index. Concurrent callers share one run.
   *  Rejects on failure (keeping the previous index). */
  function refresh() {
    if (inflight) return inflight;
    const p = listAll();
    inflight = p;
    const clear = () => { if (inflight === p) inflight = null; };
    p.then(clear, clear);
    return p;
  }

  /** Load the index once (never throws — failures land in lastError and the
   *  next call tries again while the index has never loaded). */
  async function ensureIndex() {
    if (indexLoaded) return;
    try { await refresh(); } catch { /* recorded in lastError */ }
  }

  async function putBuffer(buf, savePath) {
    const key = requireKey(savePath, 'store');
    const body = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    const md5 = crypto.createHash('md5').update(body).digest();
    const resp = await s3.send(
      new sdk.PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentLength: body.length,
        ContentType: contentTypeFor(key),
        ContentMD5: md5.toString('base64'),
      })
    );
    const meta = {
      size: body.length,
      etag: stripQuotes(resp && resp.ETag) || md5.toString('hex'),
      lastModified: new Date().toISOString(),
    };
    recordMutation({ op: 'put', key, meta });
    return { key, size: body.length };
  }

  async function getBuffer(savePath) {
    const key = requireKey(savePath, 'read');
    const resp = await s3.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key }));
    return Buffer.from(await resp.Body.transformToByteArray());
  }

  return {
    mode: 'r2',
    root: rootAbs,
    bucket,
    get index() { return index; },
    stagingDir() {
      const dir = stagingRoot || path.join(os.tmpdir(), 'bookhunt-staging');
      // Staging is wiped per attempt — never let it alias the real book dir.
      if (path.resolve(dir) === rootAbs) {
        throw new Error('STORAGE_STAGING_DIR must not be the download directory');
      }
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    existsSync(savePath) {
      const key = keyFor(savePath, rootAbs);
      return key ? index.has(key) : false;
    },
    ensureIndex,
    refresh,
    async putFile(srcPath, savePath) {
      requireKey(savePath, 'store');
      const buf = await fs.promises.readFile(srcPath);
      return putBuffer(buf, savePath);
    },
    putBuffer,
    getBuffer,
    async remove(savePath) {
      const key = keyFor(savePath, rootAbs);
      if (!key) return false;
      const had = index.has(key);
      await s3.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: key })); // idempotent
      recordMutation({ op: 'del', key });
      return had;
    },
    async list() {
      await ensureIndex();
      const out = [];
      for (const [key, meta] of index) {
        const savePath = savePathForKey(key, rawRoot);
        if (!savePath) continue;
        out.push({ name: key.slice(PREFIX.length), key, size: meta.size, savePath });
      }
      return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    async stats() {
      await ensureIndex();
      const files = [];
      for (const [key, meta] of index) files.push({ name: key.slice(PREFIX.length), size: meta.size });
      return { exists: indexLoaded, ...health.epubStats(files) };
    },
    disk: () => null,
    attachment: async (savePath) => ({ content: await getBuffer(savePath) }),
    healthInfo: () => ({
      mode: 'r2',
      bucket,
      ok: indexLoaded && !lastError,
      indexLoaded,
      objectCount: index.size,
      lastRefreshAt,
      lastError,
    }),
    displayPath: () => `r2://${bucket}/${PREFIX}`,
  };
}

// --- module singleton --------------------------------------------------------
// Always fetch the driver per call (storage.get()), never capture it at module
// load, so tests' _setDriver takes effect.

let _driver = null;
let _timer = null;

function buildDriver(cfg) {
  if (cfg.mode === 'local') return createLocalDriver({ root: cfg.root });
  return createR2Driver(cfg);
}

/** Build + install the driver from env. Throws StorageConfigError on bad config. */
function init(env = process.env) {
  _driver = buildDriver(configFromEnv(env));
  return _driver;
}

/** The active driver (lazily initialised from process.env on first use). */
function get() {
  if (!_driver) init(process.env);
  return _driver;
}

function _setDriver(d) {
  _driver = d;
}

function _reset() {
  _driver = null;
  if (_timer) clearInterval(_timer);
  _timer = null;
}

/** Periodically refresh the r2 index (picks up changes made outside this
 *  process). Errors are swallowed and logged (message only). Unref'd. */
function startRefreshTimer(ms = 600000) {
  if (_timer) clearInterval(_timer);
  _timer = setInterval(() => {
    let d;
    try { d = get(); } catch { return; }
    if (!d || d.mode === 'local') return;
    d.refresh().catch((err) => {
      console.error(`[storage] R2 index refresh failed: ${(err && err.message) || err}`);
    });
  }, ms);
  if (_timer.unref) _timer.unref();
  return _timer;
}

/**
 * Best-effort cleanup of stale per-attempt staging dirs (`dl-*`) left behind by
 * a crash. Only touches `dl-*` DIRECTORIES directly inside `root`, older than
 * maxAgeMs. Returns how many it removed.
 */
function sweepStaging(root, maxAgeMs = 60 * 60 * 1000, now = Date.now()) {
  if (!root) return 0;
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const d of entries) {
    if (!d.isDirectory() || !d.name.startsWith('dl-')) continue;
    const p = path.join(root, d.name);
    try {
      if (now - fs.statSync(p).mtimeMs <= maxAgeMs) continue;
      fs.rmSync(p, { recursive: true, force: true });
      removed++;
    } catch { /* best effort */ }
  }
  return removed;
}

module.exports = {
  PREFIX,
  BOOK_EXT_RE,
  keyFor,
  savePathForKey,
  configFromEnv,
  r2ConfigFromEnv,
  StorageConfigError,
  createLocalDriver,
  createR2Driver,
  init,
  get,
  _setDriver,
  _reset,
  startRefreshTimer,
  sweepStaging,
};
