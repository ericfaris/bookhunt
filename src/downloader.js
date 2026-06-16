'use strict';

const fs = require('fs');
const path = require('path');
const { getSession, ensureReady, enqueue, randomDelay, fetchDetail, fuzzyMatch } = require('./searcher');
const { readEpubMetadata, parseEpubBuffer } = require('./epub');
const { sniffArchive, extractEpubs } = require('./archive');

const DOWNLOAD_PATH = process.env.DOWNLOAD_PATH || 'C:\\temp';
const PREMIUM_BASE =
  'https://dl.mobilism.org/amember/downloader/downloader/app/bindex3.php';

// How long to wait for a download to materialize. Big files / slow transloads
// can take a while, so this is generous and overridable.
const DOWNLOAD_TIMEOUT = Number(process.env.PREMIUM_DOWNLOAD_TIMEOUT_MS) || 120000;
// File extensions the downloader may serve (book + archive formats). Used to
// recognize a served-file link regardless of how a given host's page is laid out.
const FILE_EXT_RE = /\.(epub|mobi|azw3?|pdf|rar|zip|7z|cbz|cbr|txt)(\?|$)/i;
// Words that indicate a failed download page (host pages vary, so match broadly).
const ERROR_RE = /\b(not found|no such file|error|invalid|expired|denied|forbidden|unavailable|failed|offline|deleted)\b/i;

// Premium downloader credentials — held in memory for the session.
// Optionally seeded from the environment at startup (MOBILISM_PREMIUM_USER /
// MOBILISM_PREMIUM_PASS); the in-app form overrides them at any time.
let premiumCreds =
  process.env.MOBILISM_PREMIUM_USER && process.env.MOBILISM_PREMIUM_PASS
    ? { user: process.env.MOBILISM_PREMIUM_USER, pass: process.env.MOBILISM_PREMIUM_PASS }
    : null;

function setPremiumCreds(user, pass) {
  premiumCreds = { user, pass };
}

function hasPremiumCreds() {
  return !!premiumCreds;
}

function clearPremiumCreds() {
  premiumCreds = null;
}

/**
 * Verify a saved file is a real EPUB and not a truncated file or an HTML error
 * page served by the downloader. Checks the ZIP magic (EPUBs are ZIP files) and
 * a sane size, plus the EPUB `mimetype` header when present (the spec requires
 * the first ZIP entry to be an uncompressed `mimetype` = application/epub+zip).
 * Returns { ok, size, epub }.
 */
function verifyEpub(filePath) {
  try {
    const { size } = fs.statSync(filePath);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(60);
    fs.readSync(fd, buf, 0, 60, 0);
    fs.closeSync(fd);
    const isZip = buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
    const epub =
      buf.slice(30, 38).toString('latin1') === 'mimetype' &&
      buf.slice(38, 58).toString('latin1') === 'application/epub+zip';
    return { ok: isZip && size > 1024, size, epub };
  } catch {
    return { ok: false, size: 0, epub: false };
  }
}

/**
 * Verify a saved file is the *correct book*, not just a valid ZIP: run the
 * structural check (verifyEpub), then dive into the ePUB and compare its
 * embedded <dc:title> against the title we searched for.
 *
 * Returns { ok, size, epub, embeddedTitle, embeddedAuthor, titleMatch } where
 * `titleMatch` is true / false / null (null = couldn't read the title, e.g. a
 * non-ePUB format or an unreadable package — so there's nothing to compare).
 */
function verifyBook(filePath, expectedTitle) {
  const v = verifyEpub(filePath);
  const out = {
    ok: v.ok,
    size: v.size,
    epub: v.epub,
    embeddedTitle: '',
    embeddedAuthor: '',
    titleMatch: null,
  };
  if (!v.ok || !v.epub) return out; // not an ePUB → no embedded metadata to read
  const meta = readEpubMetadata(filePath);
  if (!meta.ok || !meta.title) return out; // couldn't read it — leave titleMatch null
  out.embeddedTitle = meta.title;
  out.embeddedAuthor = meta.author;
  if (expectedTitle) {
    // fuzzyMatch (from searcher) requires every query token to appear in the
    // target; check both directions so a longer/shorter side still matches.
    out.titleMatch =
      fuzzyMatch(expectedTitle, meta.title) || fuzzyMatch(meta.title, expectedTitle);
  }
  return out;
}

function ensureDownloadDir() {
  try {
    fs.mkdirSync(DOWNLOAD_PATH, { recursive: true });
  } catch {
    /* best effort; saveAs will surface a real error if the path is bad */
  }
}

/**
 * Log into the premium downloader if its login form is presented (fields are
 * named username/password with a submit named "submit").
 *
 * Note: the premium password may differ from the forum password (Mobilism sends
 * it by PM). It is a separate login from the forum session.
 */
async function ensurePremiumLogin(page) {
  const loginField = await page.$('input[name="username"]');
  if (!loginField) return; // already authenticated / no form shown
  if (!premiumCreds) throw new Error('Premium credentials required');
  await page.fill('input[name="username"]', premiumCreds.user);
  await page.fill('input[name="password"]', premiumCreds.pass);
  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    page.click('input[name="submit"], input[type="submit"], button[type="submit"]'),
  ]);
  await page.waitForTimeout(1000);
  // If the password field is STILL present after submitting, the credentials were
  // rejected. (Detecting this precisely — rather than scanning the page for words
  // like "invalid"/"incorrect" — avoids false rejections, since downloader pages
  // use those words for bad links/files too.) This is account-level, so fatal.
  if (await page.$('input[name="password"]')) {
    throw fatalError('Premium login was rejected — check MOBILISM_PREMIUM_USER / PREMIUM_PASS.');
  }
}

/**
 * Throws a clear error if the downloader page reports an expired/invalid
 * account. These are marked `fatal` — they apply to the account, not to one
 * link, so the caller aborts the remaining links instead of retrying them all.
 */
function fatalError(message) {
  const err = new Error(message);
  err.fatal = true;
  return err;
}

async function assertAccountActive(page) {
  const body = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  if (/account expired|renew account/i.test(body)) {
    const m = body.match(/Expiration:\s*([\d-]+)/i);
    throw fatalError(
      `Premium account is expired${m ? ` (expired ${m[1]})` : ''}. Renew it on Mobilism to download.`
    );
  }
  // Login-rejection is detected precisely in ensurePremiumLogin (form persists),
  // not by scanning page text here — too many false positives otherwise.
}

/** Trim stray quotes/encoded-quotes/brackets that some downloader markup leaves
 *  on a scraped URL (e.g. `...epub&quot;`). */
function sanitizeUrl(u) {
  return String(u || '').replace(/(&quot;|["'\s>]+)$/g, '').trim();
}

/** Tidy a downloader error string for display (e.g. `title>Not Found`). */
function cleanError(t) {
  return String(t || '').replace(/\s+/g, ' ').replace(/^title>?\s*/i, '').trim() || 'download failed';
}

/** True if a buffer's start looks like an HTML/XML document (a landing/error
 *  page, not a real book file — real epubs are ZIPs, PDFs start with %PDF, etc.).
 *  Tolerates a leading BOM/whitespace and matches bare error fragments like
 *  `<title>Not Found</title>` that some hosts return without a full <html> wrap. */
function looksLikeHtmlBuffer(buf) {
  const head = (buf || Buffer.alloc(0))
    .slice(0, 512)
    .toString('latin1')
    .replace(/^[\s﻿ï»¿]+/, '') // strip leading BOM + whitespace
    .toLowerCase();
  return /^(<!doctype|<\?xml|<html|<head|<body|<title|<meta|<script|<!--)/.test(head);
}

/** Pull a short, human-readable reason out of an HTML/error page that a mirror
 *  served instead of a file — e.g. `<title>Not Found</title>` → "Not Found", or
 *  a bare "Not Found" body → "Not Found". Returns '' when nothing useful is
 *  found, so callers can fall back to a generic message. */
function describeErrorPage(buf) {
  const text = (buf || Buffer.alloc(0)).slice(0, 2048).toString('latin1');
  const title = text.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (title && title[1].trim()) return cleanError(title[1]);
  const err = text.match(ERROR_RE);
  if (err) return cleanError(err[0]);
  return '';
}

/** Build the user-facing "this mirror gave us junk, not a book" message,
 *  naming the concrete reason when we can read one off the error page. */
function notABookFileError(reason) {
  return reason
    ? `The premium download isn’t available anymore — the downloader returned “${reason}”.`
    : 'The mirror returned an error page, not a book file.';
}

/** True if a saved file is actually an HTML page (by extension or by content). */
function isHtmlFile(filePath, filename) {
  if (/\.html?$/i.test(filename || filePath || '')) return true;
  try {
    const fd = fs.openSync(filePath, 'r');
    const b = Buffer.alloc(256);
    const n = fs.readSync(fd, b, 0, 256, 0);
    fs.closeSync(fd);
    return looksLikeHtmlBuffer(b.slice(0, n));
  } catch {
    return false;
  }
}

/** Strip characters illegal in Windows/Unix filenames, collapse whitespace, and
 *  trim trailing dots/spaces (illegal as a Windows filename ending). */
function fsSafe(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
}

/** First standalone 4-digit year (19xx/20xx) in a string, or null. */
function extractYear(text) {
  const m = String(text || '').match(/\b(?:19|20)\d{2}\b/);
  return m ? m[0] : null;
}

/** Reduce a forum topic title to just the work's title for a filename: drop the
 *  trailing "by Author…" (author is bracketed separately) and any trailing
 *  format/edition/year parenthetical or dash-delimited format tail. */
function cleanBookTitle(t) {
  let s = String(t || '');
  s = s.replace(/\s+by\s+.+$/i, ''); // "… by Jane Doe (2024, Pub)"
  s = s.replace(/\s*[-–—]\s*(?:retail|epub|pdf|mobi|azw3?|m4b|mp3|flac|cbr|cbz)\b.*$/i, '');
  s = s.replace(
    /\s*[([][^)\]]*\b(?:retail|epub|pdf|mobi|azw3?|edition|version|19\d{2}|20\d{2})\b[^)\]]*[)\]]\s*$/i,
    ''
  );
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Build a tidy "Title [Author] (Year).ext" filename from book metadata,
 * preserving the served file's extension. Author and year are included only
 * when present. Falls back to a sanitized form of the original name when there
 * is no usable title.
 */
function buildBookFilename(meta, originalName) {
  const m = meta || {};
  const ext = (path.extname(originalName || '') || '.epub').toLowerCase();
  const title = fsSafe(cleanBookTitle(m.title));
  if (!title) return fsSafe(originalName) || `download${ext}`;
  const author = fsSafe(m.author);
  const year = extractYear(m.title);
  let name = title;
  if (author) name += ` [${author}]`;
  if (year) name += ` (${year})`;
  if (name.length > 200) name = name.slice(0, 200).trim(); // filesystem name limit
  return name + ext;
}

/** True only for a real .epub path that resolves inside `root` (no traversal). */
function isSafeEpubPath(savePath, root) {
  if (!savePath || !root) return false;
  const r = path.resolve(root);
  const p = path.resolve(savePath);
  return p.startsWith(r + path.sep) && p.toLowerCase().endsWith('.epub');
}

/**
 * Fallback save: fetch a known file URL with the browser context's cookies and
 * write it to disk. Used when navigating to the file didn't surface a Playwright
 * download event (some hosts serve inline rather than as an attachment).
 */
async function saveViaRequest(page, fileUrl, meta) {
  try {
    const resp = await page.context().request.get(fileUrl, { timeout: DOWNLOAD_TIMEOUT });
    if (!resp.ok()) return null;
    const buf = await resp.body();
    // Reject anything that isn't a real book file BEFORE writing it to disk, and
    // surface a concrete reason so the user learns *why* (e.g. "Not Found").
    if (!buf || buf.length < 1024) {
      // A tiny response is never a real book — usually a bare error string.
      const reason = describeErrorPage(buf);
      return reason ? { error: notABookFileError(reason) } : null;
    }
    if (looksLikeHtmlBuffer(buf)) {
      return { error: notABookFileError(describeErrorPage(buf)) }; // HTML landing/error page
    }
    const base = (fileUrl.split('/').pop() || 'download').split('?')[0];
    const original = decodeURIComponent(base).replace(/[\r\n"]/g, '') || 'download';
    if (/\.html?$/i.test(original)) return { error: notABookFileError('') }; // page, not a file
    const filename = buildBookFilename(meta, original); // tidy "Title [Author] (Year).ext"
    const savePath = path.join(DOWNLOAD_PATH, filename);
    fs.writeFileSync(savePath, buf);
    return { filename, savePath };
  } catch {
    return null;
  }
}

/** First letter of every word, uppercased — e.g. "The Calamity Club" → "TCC". */
function makeAbbr(title) {
  return (title || '')
    .split(/\s+/)
    .map((w) => (w[0] || '').toUpperCase())
    .join('');
}

/**
 * Return true if a collection-post section header matches the target title.
 * Handles both the full name ("The Calamity Club") and initials ("TCC").
 */
function sectionMatchesTitle(sectionHeader, title) {
  if (!sectionHeader || !title) return false;
  if (fuzzyMatch(title, sectionHeader) || fuzzyMatch(sectionHeader, title)) return true;
  const abbr = makeAbbr(title);
  const normHeader = (sectionHeader || '').replace(/[\s\W]/g, '').toUpperCase();
  return abbr.length >= 2 && normHeader === abbr;
}

/**
 * Choose which postlinks to treat as mirrors of the wanted book.
 *
 * 1. Prefer links flagged with a Premium icon; if the adjacency heuristic found
 *    none (markup variant), fall back to all postlinks.
 * 2. For multi-book collection posts ("Books by Author"), each book has its own
 *    section (a title or abbreviation like "W:" for *Whistler*, "TL:" …) with its
 *    own mirror links — plus often a first "Download Instructions" link that is an
 *    archive of ALL the books. Keep only links whose section header matches the
 *    target book, so the per-book links win over the all-books archive. If the
 *    post title itself matches the target, it's a single-book post and no
 *    section filtering is applied.
 */
function selectPremiumLinks(postlinks, detailTitle, targetTitle) {
  const flagged = postlinks.filter((l) => l.premium);
  let links = flagged.length ? flagged : postlinks;
  if (targetTitle && !fuzzyMatch(targetTitle, detailTitle)) {
    const sectionFiltered = links.filter((l) => sectionMatchesTitle(l.sectionHeader, targetTitle));
    if (sectionFiltered.length > 0) links = sectionFiltered;
  }
  return links;
}

/**
 * Premium download path. Opens the topic, finds the postlinks associated with a
 * Premium icon, and treats them as MIRRORS of one file: it tries each through
 * the amember downloader in order and stops at the first that downloads
 * successfully, saving to DOWNLOAD_PATH. Failed mirrors are recorded in `errors`.
 *
 * `targetTitle` is the user's searched title — used to filter links to only those
 * under the correct book's section in multi-book collection posts.
 *
 * Returns { downloads: [{ filename, savePath, url, timestamp, verified, size }], errors: [...] }
 */
function premiumDownload(topicUrl, onProgress, targetTitle) {
  // Queued: the browser page is shared with searches, so download runs must
  // wait their turn rather than interleave navigations.
  return enqueue(() => runPremiumDownload(topicUrl, onProgress, targetTitle));
}

async function runPremiumDownload(topicUrl, onProgress = () => {}, targetTitle) {
  if (!premiumCreds) throw new Error('Premium credentials not set for this session');
  ensureDownloadDir();

  onProgress({ step: 'reading-post' });
  const { page } = await getSession();
  await ensureReady(page); // forum login required to read the topic (throws needWarm if stale)
  const detail = await fetchDetail(page, topicUrl);
  if (!detail) throw new Error('Could not read post content');
  if (!detail.premium) {
    throw new Error('No Premium icon found on this post — use the standard links');
  }

  const premiumLinks = selectPremiumLinks(detail.postlinks, detail.title, targetTitle);

  onProgress({ step: 'mirrors-found', total: premiumLinks.length });

  // Carried into each mirror so saved files get a tidy "Title [Author] (Year)"
  // name instead of the host's raw filename, and so verification can confirm
  // the embedded ePUB title matches what we searched for.
  const meta = { title: targetTitle || detail.title, author: detail.author };
  const { downloads, errors } = await runMirrors(
    premiumLinks,
    (link) => attemptLink(page, link, meta, onProgress),
    onProgress
  );
  return { downloads, errors, title: detail.title, description: detail.description || '' };
}

/**
 * Mirror orchestration — separated from Playwright so it can be unit-tested.
 * Tries each link via `attempt(link)`, STOPS at the first that returns a saved
 * file, collects failures in `errors`, and lets a fatal (account-level) error
 * abort the whole run. `attempt` resolves to { filename, savePath, verified,
 * size } on success, or throws on failure (set err.fatal = true to abort).
 * `onProgress` (optional) is notified as each mirror is tried / fails.
 */
async function runMirrors(links, attempt, onProgress = () => {}) {
  const downloads = [];
  const errors = [];
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    onProgress({ step: 'mirror', index: i + 1, total: links.length, host: link.host });
    try {
      const saved = await attempt(link);
      downloads.push({ ...saved, url: link.url, timestamp: new Date().toISOString() });
      break; // mirrors: one good download is enough
    } catch (err) {
      if (err.fatal) throw err; // account-level — abort remaining mirrors
      onProgress({ step: 'mirror-failed', host: link.host, error: err.message });
      errors.push({ url: link.url, error: err.message });
    }
  }
  return { downloads, errors };
}

/**
 * Try a single mirror through the amember downloader, which ends in one of:
 *   (a) it streams the file immediately (download event fires);
 *   (b) a transload progress page that finishes "Saved!" and meta-refreshes to
 *       the finished file at .../app/files/... (can take minutes);
 *   (c) a direct "Download: <a download href=.../app/files/...>" link;
 *   (d) an error like "Not Found" (no download event ever fires).
 * Resolves to { filename, savePath, verified, size } on success, or throws
 * (Error.fatal set for account-level failures).
 */
async function attemptLink(page, link, meta, onProgress = () => {}) {
  await randomDelay();
  const target = `${PREMIUM_BASE}?dl=${encodeURIComponent(link.url)}`;

  // Listen for a download up front, then poll for whichever state appears.
  const downloadPromise = page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT }).catch(() => null);
  await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => {});

  onProgress({ step: 'login' });
  await ensurePremiumLogin(page);  // throws fatal if credentials are rejected
  await assertAccountActive(page); // throws fatal on an expired account
  onProgress({ step: 'downloading', host: link.host });

  let download = null;
  let fileUrl = null;
  let errText = '';
  const startedAt = Date.now();
  const deadline = startedAt + DOWNLOAD_TIMEOUT;
  while (Date.now() < deadline) {
    // A download may already be underway (direct stream, or the transload
    // page's meta-refresh navigating to the finished file).
    download = await Promise.race([downloadPromise, page.waitForTimeout(1000).then(() => null)]);
    if (download) break;

    // Host pages vary, so detect the served file generically: an explicit
    // download link, a meta-refresh, a link into the downloader's files/ dir,
    // or any link whose URL ends in a known file extension.
    const probe = await page.evaluate(({ extSrc, errSrc }) => {
      const extRe = new RegExp(extSrc, 'i');
      const errRe = new RegExp(errSrc, 'i');
      const abs = (a) => (a && a.getAttribute('href') ? a.href : null);
      let url = abs(document.querySelector('a[download][href]'));
      if (!url) {
        const m = document.querySelector('meta[http-equiv="refresh" i]');
        const c = m ? m.getAttribute('content') || '' : '';
        const i = c.toLowerCase().indexOf('url=');
        if (i >= 0) url = c.slice(i + 4).trim();
      }
      if (!url) url = abs(document.querySelector('a[href*="/app/files/"]'));
      if (!url) {
        for (const a of document.querySelectorAll('a[href]')) {
          if (extRe.test(a.getAttribute('href') || '') || extRe.test(a.href)) { url = a.href; break; }
        }
      }
      const errEl = document.querySelector('.htmlerror, .error, .alert');
      const body = (document.body && document.body.innerText) || '';
      return {
        url,
        errEl: errEl ? errEl.textContent.trim() : '',
        // Error words anywhere on the page — fallback for hosts that don't use
        // a recognizable error element.
        bodyErr: errRe.test(body),
        // "complete" markers seen across hosts — keep waiting if present but the
        // file link hasn't rendered yet.
        saved: /saved!|download complete|100%\s*downloaded/i.test(body),
      };
    }, { extSrc: FILE_EXT_RE.source, errSrc: ERROR_RE.source })
      .catch(() => ({ url: null, errEl: '', bodyErr: false, saved: false }));

    if (probe.url) { fileUrl = sanitizeUrl(probe.url); break; }
    // No file link, no "complete" marker, and an error showing → the host
    // failed. Fail fast. "Download:" appears in a SUCCESS panel, so never treat
    // that as an error. Grace period avoids false failure on transient states.
    const panelErr = probe.errEl && !/download:/i.test(probe.errEl);
    if (Date.now() - startedAt > 4000 && !probe.saved && (panelErr || probe.bodyErr)) {
      errText = probe.errEl || 'download failed';
      break;
    }
  }

  // Found a file URL but no download yet — fetch it. Navigating in the headed
  // browser carries the session + Cloudflare clearance; if that doesn't surface
  // a download event, fall back to the context request API.
  if (!download && fileUrl) {
    const dl2 = page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT }).catch(() => null);
    await page.goto(fileUrl, { waitUntil: 'commit' }).catch(() => {});
    download = await dl2;
    if (!download) {
      const saved = await saveViaRequest(page, fileUrl, meta);
      if (saved && saved.error) throw new Error(saved.error); // error page, not a file
      if (saved) {
        onProgress({ step: 'saved', filename: saved.filename });
        return finalizeDownload(saved.savePath, saved.filename, meta, onProgress);
      }
    }
  }

  if (!download) {
    if (errText) throw new Error(notABookFileError(cleanError(errText)));
    throw new Error('No download was triggered by this mirror.');
  }

  const original = download.suggestedFilename();
  const filename = buildBookFilename(meta, original); // tidy "Title [Author] (Year).ext"
  const savePath = path.join(DOWNLOAD_PATH, filename);
  await download.saveAs(savePath);
  console.error('[premium] saved %s (host name %s) from fileUrl=%s', filename, original, fileUrl || '(download event)');
  // Some hosts serve an HTML landing/error page as the "download" — reject it so
  // it counts as a failed mirror, not a bogus success, and tell the user why.
  if (isHtmlFile(savePath, original)) {
    let reason = '';
    try { reason = describeErrorPage(fs.readFileSync(savePath)); } catch {}
    try { fs.unlinkSync(savePath); } catch {}
    throw new Error(notABookFileError(reason));
  }
  onProgress({ step: 'saved', filename });
  return finalizeDownload(savePath, filename, meta, onProgress);
}

/**
 * Choose which inner ePUB to keep when an archive holds more than one. Prefers
 * the one whose embedded title matches what we searched for (so a multi-book
 * bundle yields the right book); otherwise falls back to the largest entry.
 */
function pickEpub(epubs, expectedTitle) {
  if (epubs.length === 1) return epubs[0];
  if (expectedTitle) {
    for (const e of epubs) {
      const m = parseEpubBuffer(e.data);
      if (
        m.ok &&
        m.title &&
        (fuzzyMatch(expectedTitle, m.title) || fuzzyMatch(m.title, expectedTitle))
      ) {
        return e;
      }
    }
  }
  return epubs.reduce((a, b) => (b.data.length > a.data.length ? b : a));
}

/**
 * Releases are often the EPUB wrapped in a ZIP/RAR. If the saved file is such an
 * archive, pull the inner ePUB out, write it to DOWNLOAD_PATH, delete the
 * archive, and return the new { savePath, filename } so verification + send-to-
 * reader operate on the real ePUB. A bare ePUB (or non-archive) passes through
 * untouched. Throws (→ failed mirror) if a recognized archive has no usable ePUB.
 */
async function resolveArchive(savePath, filename, meta, onProgress = () => {}) {
  const kind = sniffArchive(savePath);
  if (kind !== 'zip' && kind !== 'rar') return { savePath, filename };

  onProgress({ step: 'extracting', filename, archive: kind });
  let epubs;
  try {
    epubs = await extractEpubs(savePath);
  } catch (err) {
    try { fs.unlinkSync(savePath); } catch {}
    throw new Error(`Could not read the ${kind.toUpperCase()} archive: ${err.message}`);
  }
  if (!epubs.length) {
    try { fs.unlinkSync(savePath); } catch {}
    throw new Error(`No EPUB found inside the ${kind.toUpperCase()} archive`);
  }

  const chosen = pickEpub(epubs, meta && meta.title);
  const newFilename = buildBookFilename(meta, chosen.name); // ".epub" extension
  const epubPath = path.join(DOWNLOAD_PATH, newFilename);
  fs.writeFileSync(epubPath, chosen.data);
  // Remove the archive now that the ePUB is extracted (unless, improbably, the
  // tidy name resolved to the archive's own path).
  if (path.resolve(epubPath) !== path.resolve(savePath)) {
    try { fs.unlinkSync(savePath); } catch {}
  }
  onProgress({ step: 'extracted', filename: newFilename, from: filename, count: epubs.length });
  return { savePath: epubPath, filename: newFilename };
}

/**
 * Verify a freshly-saved file is the correct book and shape the success record.
 * First unwraps a ZIP/RAR archive to the inner ePUB if needed. Emits `verifying`
 * then `verified` progress so the UI can show exactly what was checked
 * (structure + embedded title match).
 */
async function finalizeDownload(savePath, filename, meta, onProgress = () => {}) {
  ({ savePath, filename } = await resolveArchive(savePath, filename, meta, onProgress));
  // Final backstop: never keep an HTML/error page that slipped through every
  // earlier guard as a "book". Delete it and fail the mirror with a clear reason.
  if (isHtmlFile(savePath, filename)) {
    let reason = '';
    try { reason = describeErrorPage(fs.readFileSync(savePath)); } catch {}
    try { fs.unlinkSync(savePath); } catch {}
    throw new Error(notABookFileError(reason));
  }
  onProgress({ step: 'verifying', filename });
  const v = verifyBook(savePath, meta && meta.title);
  onProgress({
    step: 'verified',
    filename,
    verified: v.ok,
    titleMatch: v.titleMatch,
    embeddedTitle: v.embeddedTitle,
    embeddedAuthor: v.embeddedAuthor,
    size: v.size,
  });
  return {
    filename,
    savePath,
    verified: v.ok,
    size: v.size,
    embeddedTitle: v.embeddedTitle,
    embeddedAuthor: v.embeddedAuthor,
    titleMatch: v.titleMatch,
  };
}

module.exports = {
  DOWNLOAD_PATH,
  setPremiumCreds,
  hasPremiumCreds,
  clearPremiumCreds,
  premiumDownload,
  verifyEpub,
  verifyBook,
  // exported for unit tests
  sanitizeUrl,
  cleanError,
  describeErrorPage,
  notABookFileError,
  isSafeEpubPath,
  looksLikeHtmlBuffer,
  isHtmlFile,
  fsSafe,
  extractYear,
  cleanBookTitle,
  buildBookFilename,
  ensurePremiumLogin,
  assertAccountActive,
  runMirrors,
  makeAbbr,
  sectionMatchesTitle,
  selectPremiumLinks,
  pickEpub,
  resolveArchive,
  finalizeDownload,
};
