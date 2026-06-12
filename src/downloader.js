'use strict';

const fs = require('fs');
const path = require('path');
const { getSession, ensureReady, enqueue, randomDelay, fetchDetail } = require('./searcher');

const DOWNLOAD_PATH = process.env.DOWNLOAD_PATH || 'C:\\temp';
const PREMIUM_BASE =
  'https://dl.mobilism.org/amember/downloader/downloader/app/bindex3.php';

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
      // Navigating may show the downloader login, an error page, or kick off
      // the file download directly — start listening before we navigate.
      const downloadPromise = page.waitForEvent('download', { timeout: 60000 }).catch(() => null);
      await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => {});

      await ensurePremiumLogin(page);
      await assertAccountActive(page); // throws fatal on expired/invalid account

      // If the navigation/login already triggered the download it resolves
      // instantly; otherwise give it a short window before trying the button —
      // not the listener's full timeout.
      let download = await Promise.race([
        downloadPromise,
        page.waitForTimeout(5000).then(() => null),
      ]);
      if (!download) {
        // After auth the page may present a download link/button — click it.
        const btn = await page.$('a.download, a[href*="download"], a[href$=".epub"], input[type="submit"], button');
        if (btn) {
          const dl2 = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
          await btn.click().catch(() => {});
          download = await dl2;
        }
      }

      if (!download) {
        errors.push({ url: link.url, error: 'No download was triggered' });
        continue;
      }

      const filename = download.suggestedFilename();
      const savePath = path.join(DOWNLOAD_PATH, filename);
      await download.saveAs(savePath);
      downloads.push({ filename, savePath, url: link.url, timestamp: new Date().toISOString() });
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
};
