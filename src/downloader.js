'use strict';

const fs = require('fs');
const path = require('path');
const { getSession, ensureReady, enqueue, randomDelay, fetchDetail } = require('./searcher');

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
  if (/incorrect|invalid|wrong (?:username|password)/i.test(body)) {
    throw fatalError('Premium login was rejected — check MOBILISM_PREMIUM_USER / PREMIUM_PASS.');
  }
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
async function saveViaRequest(page, fileUrl) {
  try {
    const resp = await page.context().request.get(fileUrl, { timeout: DOWNLOAD_TIMEOUT });
    if (!resp.ok()) return null;
    const buf = await resp.body();
    if (!buf || buf.length < 1024) return null; // too small to be a real file
    const base = (fileUrl.split('/').pop() || 'download').split('?')[0];
    const filename = decodeURIComponent(base).replace(/[\r\n"]/g, '') || 'download';
    const savePath = path.join(DOWNLOAD_PATH, filename);
    fs.writeFileSync(savePath, buf);
    return { filename, savePath };
  } catch {
    return null;
  }
}

/**
 * Premium download path. Opens the topic, finds every postlink associated with
 * a Premium icon, and downloads each through the amember downloader, saving to
 * DOWNLOAD_PATH.
 *
 * Returns { downloads: [{ filename, savePath, url, timestamp }], errors: [...] }
 */
function premiumDownload(topicUrl) {
  // Queued: the browser page is shared with searches, so download runs must
  // wait their turn rather than interleave navigations.
  return enqueue(() => runPremiumDownload(topicUrl));
}

async function runPremiumDownload(topicUrl) {
  if (!premiumCreds) throw new Error('Premium credentials not set for this session');
  ensureDownloadDir();

  const { page } = await getSession();
  await ensureReady(page); // forum login required to read the topic (throws needWarm if stale)
  const detail = await fetchDetail(page, topicUrl);
  if (!detail) throw new Error('Could not read post content');
  if (!detail.premium) {
    throw new Error('No Premium icon found on this post — use the standard links');
  }

  const downloads = [];
  const errors = [];

  // Only run links that have a premium icon next to them; if the adjacency
  // heuristic found none (markup variant), fall back to all postlinks. The
  // links themselves change between visits, so they're always scraped fresh
  // from the post above — never cached.
  const flagged = detail.postlinks.filter((l) => l.premium);
  const premiumLinks = flagged.length ? flagged : detail.postlinks;

  for (const link of premiumLinks) {
    await randomDelay();
    const target = `${PREMIUM_BASE}?dl=${encodeURIComponent(link.url)}`;
    try {
      // The amember downloader ends in one of several terminal states:
      //  (a) it streams the file immediately (download event fires);
      //  (b) a transload progress page that finishes "Saved!" and meta-refreshes
      //      to the finished file at .../app/files/... (can take minutes);
      //  (c) a direct "Download: <a download href=.../app/files/...>" link;
      //  (d) an error like "Not Found" (no download event ever fires).
      // Listen for a download up front, then poll for whichever state appears.
      const downloadPromise = page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT }).catch(() => null);
      await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => {});

      await ensurePremiumLogin(page);
      await assertAccountActive(page); // throws fatal on expired/invalid account

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
        // download link, a meta-refresh, a link into the downloader's files/
        // dir, or any link whose URL ends in a known file extension.
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
            // Error words anywhere on the page — fallback for hosts that don't
            // use a recognizable error element.
            bodyErr: errRe.test(body),
            // "complete" markers seen across hosts — keep waiting if present but
            // the file link hasn't rendered yet.
            saved: /saved!|download complete|100%\s*downloaded/i.test(body),
          };
        }, { extSrc: FILE_EXT_RE.source, errSrc: ERROR_RE.source })
          .catch(() => ({ url: null, errEl: '', bodyErr: false, saved: false }));

        if (probe.url) { fileUrl = sanitizeUrl(probe.url); break; }
        // No file link, a "complete" marker absent, and an error showing (either
        // in a panel or in the page text) → the host failed. Fail fast instead of
        // waiting out the whole timeout. "Download:" appears in a SUCCESS panel,
        // so never treat that as an error.
        // Grace period: give the page a few seconds to start a download / render
        // a link before believing an error, so transient initial states don't
        // cause a false failure.
        const panelErr = probe.errEl && !/download:/i.test(probe.errEl);
        if (Date.now() - startedAt > 4000 && !probe.saved && (panelErr || probe.bodyErr)) {
          errText = probe.errEl || 'download failed';
          break;
        }
      }

      // Found a file URL but no download yet — fetch it. Navigating in the headed
      // browser carries the session + Cloudflare clearance; if that doesn't
      // surface a download event, fall back to the context request API.
      if (!download && fileUrl) {
        const dl2 = page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT }).catch(() => null);
        await page.goto(fileUrl, { waitUntil: 'commit' }).catch(() => {});
        download = await dl2;
        if (!download) {
          const saved = await saveViaRequest(page, fileUrl);
          if (saved) {
            const v = verifyEpub(saved.savePath);
            downloads.push({
              ...saved,
              url: link.url,
              timestamp: new Date().toISOString(),
              verified: v.ok,
              size: v.size,
            });
            continue;
          }
        }
      }

      if (!download) {
        errors.push({
          url: link.url,
          error: errText ? `Downloader: ${cleanError(errText)}` : 'No download was triggered',
        });
        continue;
      }

      const filename = download.suggestedFilename();
      const savePath = path.join(DOWNLOAD_PATH, filename);
      await download.saveAs(savePath);
      const v = verifyEpub(savePath);
      downloads.push({
        filename,
        savePath,
        url: link.url,
        timestamp: new Date().toISOString(),
        verified: v.ok,
        size: v.size,
      });
    } catch (err) {
      if (err.fatal) throw err; // account-level error — abort remaining links
      errors.push({ url: link.url, error: err.message });
    }
  }

  return { downloads, errors, title: detail.title };
}

module.exports = {
  DOWNLOAD_PATH,
  setPremiumCreds,
  hasPremiumCreds,
  clearPremiumCreds,
  premiumDownload,
  verifyEpub,
  // exported for unit tests
  sanitizeUrl,
  cleanError,
  isSafeEpubPath,
};
