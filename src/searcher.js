'use strict';

const path = require('path');
const { chromium } = require('playwright');

const BASE_URL = (process.env.MOBILISM_BASE || 'https://forum.mobilism.org').replace(/\/$/, '');
// Mobilism sits behind Cloudflare, which blocks headless browsers. We therefore
// run a real (headed) browser by default; set HEADLESS=true only if you know the
// challenge will pass. A persistent profile keeps the session + Cloudflare
// clearance cookies between runs so we rarely have to log in again.
const HEADLESS = process.env.HEADLESS === 'true';
const PROFILE_DIR = process.env.PROFILE_DIR || path.join(__dirname, '..', '.browser-profile');
// Mobilism's eBooks forum id. Searches are scoped to it (and its subforums via
// sc=1) so common terms like "1984" aren't buried under apps/games/music hits.
const EBOOKS_FID = process.env.EBOOKS_FID || '106';

// Caps from the spec
const MAX_PAGES = 5;          // pages crawled per search pass
const MAX_COLLECTIONS = 3;    // collection posts crawled per search
// Internal safety cap on how many topic pages we open for detail scraping per
// pass. Keeps a broad title search from turning into hundreds of slow requests.
const DETAIL_CAP = 15;
// "books by {author}" collection pass: it's a narrow query, so a couple of
// result pages is plenty, and we open at most this many of those set/collection
// posts to scan their contents for the requested title.
const COLLECTION_SEARCH_PAGES = 2;
const MAX_AUTHOR_COLLECTION_SCAN = 6;

const COLLECTION_KEYWORDS = ['collection', 'complete works', '&', 'series', 'omnibus'];

// ---------------------------------------------------------------------------
// Shared, authenticated browser session (one persistent session reused
// throughout). launchPersistentContext keeps cookies on disk so the Cloudflare
// clearance and forum login survive between app restarts.
// ---------------------------------------------------------------------------
let _context = null;
let _page = null;
let _loginPromise = null;

// All browser work shares one page, so tasks must run strictly sequentially —
// interleaved goto() calls would scrape whatever page the other task is on.
let _queue = Promise.resolve();
function enqueue(task) {
  const run = _queue.catch(() => {}).then(task);
  _queue = run.catch(() => {});
  return run;
}

// --- Cooperative cancellation (issue #28) ----------------------------------
// A search is a long sequence of polite-delayed page.goto()s on the SHARED
// browser page. We can't hard-abort a single navigation, so cancellation is
// cooperative: the server flips the signal when the client disconnects, the
// running scrape checks it at each row/page boundary (and aborts the polite
// delay early), and any in-flight navigation is interrupted via window.stop().
class CancelledError extends Error {
  constructor() {
    super('Search cancelled');
    this.name = 'CancelledError';
    this.cancelled = true;
  }
}

// Throw if the signal has been cancelled. No-op when no signal is passed (so the
// download/reupload paths that reuse these scrapers are unaffected).
function throwIfCancelled(signal) {
  if (signal && signal.cancelled) throw new CancelledError();
}

// Create a cancellation signal. `cancel()` fires every registered listener once
// (used to clear the polite delay + stop the live navigation); `settle()` is
// called when the work finishes so a late client-disconnect can't fire stop()
// on a page another queued task has since taken over.
function createCancelSignal() {
  const listeners = [];
  let settled = false;
  return {
    cancelled: false,
    cancel() {
      if (settled || this.cancelled) return;
      this.cancelled = true;
      for (const fn of listeners.splice(0)) {
        try { fn(); } catch { /* best-effort */ }
      }
    },
    settle() {
      settled = true;
      listeners.length = 0;
    },
    onCancel(fn) {
      if (settled) return;
      if (this.cancelled) { try { fn(); } catch { /* best-effort */ } return; }
      listeners.push(fn);
    },
  };
}

const isLoggedIn = (page) =>
  page.evaluate(() => !!document.querySelector('a[href*="mode=logout"]'));

// Playwright's browser-launch failures carry a multi-KB log (the full Chromium
// command line + stderr). Collapse that into a short, actionable message for the
// UI, keeping the raw text on `.detail` for server-side logging.
function friendlyLaunchError(err) {
  const raw = String((err && err.message) || err || '');
  let msg = 'Could not start the browser. Try re-warming the session.';
  if (/in use by another|ProcessSingleton|profile.*locked/i.test(raw)) {
    msg = 'The browser profile is already in use by another session — only one can run at a time.';
  }
  const clean = new Error(msg);
  clean.detail = raw;
  return clean;
}

// Launch (or reuse) the shared browser. This NO LONGER logs in — the browser
// now runs headed under a virtual display (Xvfb) in the container and stays
// alive whether or not the Mobilism session is authenticated, so the live
// window can be warmed via /warm (noVNC). Mobilism operations call
// ensureReady() to require a login; Amazon lookups need no login at all.
async function getSession() {
  if (_page && !_page.isClosed()) return { context: _context, page: _page };
  if (_loginPromise) return _loginPromise;

  _loginPromise = (async () => {
    let context;
    try {
      context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: HEADLESS,
        acceptDownloads: true,
        viewport: { width: 1280, height: 900 },
        // --disable-gpu* fixes the green/black screen Chromium shows under a
        // virtual/WSLg display (GPU compositing bug). --disable-dev-shm-usage
        // avoids /dev/shm crashes.
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-gpu',
          '--disable-gpu-compositing',
          '--disable-software-rasterizer',
          '--disable-dev-shm-usage',
          // Required in Docker — containers lack the kernel capabilities the
          // Chromium sandbox needs, causing it to hang silently without these.
          '--no-sandbox',
          '--disable-setuid-sandbox',
          // Open maximized so the noVNC view shows the full page.
          '--start-maximized',
        ],
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      });
    } catch (err) {
      throw friendlyLaunchError(err); // Playwright's raw launch log is huge
    }
    context.setDefaultTimeout(30000);
    context.setDefaultNavigationTimeout(30000);
    const page = context.pages()[0] || (await context.newPage());
    _context = context;
    _page = page;
    return { context: _context, page: _page };
  })();

  try {
    return await _loginPromise;
  } finally {
    _loginPromise = null;
  }
}

/**
 * Passive session check — reads cookies from the persistent profile WITHOUT
 * navigating (so it never disrupts a manual warm in progress). phpBB stores the
 * logged-in user id in a `<prefix>_u` cookie (1 = anonymous); Mobilism's prefix
 * is `ppcw_29d3s`, so match any `*_u` cookie rather than the default `phpbb3_`.
 * Cloudflare's bot clearance is the `cf_clearance` cookie.
 */
async function sessionStatus() {
  if (!_context) return { ready: false, loggedIn: false, cfOk: false, browser: false };
  const cookies = await _context.cookies(BASE_URL).catch(() => []);
  const u = cookies.find((c) => /_u$/.test(c.name));
  const loggedIn = !!u && u.value && u.value !== '1';
  const cf = cookies.find((c) => c.name === 'cf_clearance');
  const cfOk = !!cf && (!cf.expires || cf.expires < 0 || cf.expires * 1000 > Date.now());
  return { ready: loggedIn, loggedIn, cfOk, browser: true };
}

/**
 * Require an authenticated Mobilism session before a forum operation. Reuses an
 * already-logged-in profile; otherwise submits the login form once (a headed
 * browser often clears Cloudflare's JS challenge on its own). If it still isn't
 * logged in, throws a typed `needWarm` error so the UI can prompt for /warm —
 * the browser is left OPEN either way so it can be warmed live.
 */
async function ensureReady(page) {
  try {
    await ensureLoggedIn(page);
  } catch (err) {
    err.needWarm = true;
    throw err;
  }
}

async function closeSession() {
  if (_context) await _context.close().catch(() => {});
  _context = _page = null;
}

/**
 * Make sure the session is authenticated. Reuses an existing logged-in profile;
 * otherwise submits the login form and waits for the session to come up
 * (allowing time for a Cloudflare challenge to clear, or for a manual solve in
 * headed mode).
 */
async function ensureLoggedIn(page) {
  const user = process.env.MOBILISM_USER;
  const pass = process.env.MOBILISM_PASS;
  if (!user || !pass) {
    throw new Error('MOBILISM_USER and MOBILISM_PASS must be set in .env');
  }

  await page.goto(`${BASE_URL}/index.php`, { waitUntil: 'domcontentloaded' });
  if (await isLoggedIn(page)) return; // persistent profile already authenticated

  // Not logged in yet. If a Cloudflare challenge is showing, give it a moment to
  // auto-resolve, then re-check before falling through to the login form.
  if (/just a moment|security verification/i.test(await page.title())) {
    await page.waitForTimeout(5000);
    if (await isLoggedIn(page)) return;
  }

  await page.goto(`${BASE_URL}/ucp.php?mode=login`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const hasForm = await page.$('input[name="username"]');
  if (hasForm) {
    await page.fill('input[name="username"]', user);
    await page.fill('input[name="password"]', pass);
    await page.check('input[name="autologin"]').catch(() => {});
    await page.click('button[name="login"], input[name="login"]');
  }

  // Wait for login to land (or for a human to clear a challenge in headed mode).
  try {
    await page.waitForSelector('a[href*="mode=logout"]', { timeout: 30000 });
  } catch {
    /* fall through to the check below */
  }
  if (!(await isLoggedIn(page))) {
    throw new Error(
      'Could not log in to Mobilism. If a Cloudflare challenge appeared, run with ' +
        'HEADLESS unset (headed) and solve it once — the session will then persist.'
    );
  }
}

// ---------------------------------------------------------------------------
// Hands-off (re)warming — see warmUp() below. The goal is that the app keeps
// itself authenticated on its own: a headed browser usually passes Cloudflare's
// JS/Turnstile challenge unattended, and the login form is just env creds, so a
// human is only needed for an INTERACTIVE Cloudflare challenge.
// ---------------------------------------------------------------------------

// True when the current page is sitting on a Cloudflare interstitial/challenge
// (the "Just a moment…" / Turnstile screen) rather than the real forum.
async function isCloudflareChallenge(page) {
  const title = (await page.title().catch(() => '')) || '';
  if (/just a moment|attention required|checking your browser|security verification/i.test(title)) {
    return true;
  }
  return await page
    .evaluate(
      () =>
        !!document.querySelector(
          '#challenge-form, #cf-challenge-running, iframe[src*="challenges.cloudflare.com"], .cf-turnstile'
        )
    )
    .catch(() => false);
}

// Fill + submit the Mobilism login form on the LIVE page using env creds. Assumes
// you're already on (or about to navigate to) the login page and that Cloudflare
// is cleared. Returns true if the form was found and submitted.
async function submitLoginForm(page) {
  const user = process.env.MOBILISM_USER;
  const pass = process.env.MOBILISM_PASS;
  if (!user || !pass) throw new Error('MOBILISM_USER and MOBILISM_PASS must be set in .env');
  if (!(await page.$('input[name="password"]'))) return false;
  await page.fill('input[name="username"]', user).catch(() => {});
  await page.fill('input[name="password"]', pass);
  await page.check('input[name="autologin"]').catch(() => {});
  await page.click('button[name="login"], input[name="login"]').catch(() => {});
  await page.waitForSelector('a[href*="mode=logout"]', { timeout: 20000 }).catch(() => {});
  return true;
}

/**
 * Try to bring the session up WITHOUT a human. Runs on the shared queue so it
 * never collides with a search. Sequence: if already logged in, done; otherwise
 * navigate to the forum and let a headed browser auto-clear Cloudflare; if that
 * works, fill the login form. The return value tells the caller what happened so
 * it can decide whether to summon a human:
 *   { ready, action, humanNeeded }
 * `humanNeeded` is true ONLY for an interactive Cloudflare challenge that an
 * unattended browser can't pass — that's the one case /warm still exists for.
 */
async function warmUp() {
  return enqueue(async () => {
    const { page } = await getSession();
    if (await isLoggedIn(page)) return { ready: true, action: 'already', humanNeeded: false };

    // Surface current Cloudflare/login state. A headed browser usually clears the
    // JS challenge within a few seconds of landing on the page.
    await page.goto(`${BASE_URL}/index.php`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    if (await isCloudflareChallenge(page)) {
      await page.waitForTimeout(6000); // give Turnstile/JS a chance to auto-pass
      if (await isLoggedIn(page)) return { ready: true, action: 'cf-auto', humanNeeded: false };
      if (await isCloudflareChallenge(page)) {
        // Still blocked → interactive challenge. This is the only path that needs
        // a person (in /warm). Caller will notify + back off so they can solve it.
        return { ready: false, action: 'cf-blocked', humanNeeded: true };
      }
    }
    if (await isLoggedIn(page)) return { ready: true, action: 'cf-auto', humanNeeded: false };

    // Cloudflare is clear but we're not logged in → submit the login form.
    await page.goto(`${BASE_URL}/ucp.php?mode=login`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1500);
    if (await isCloudflareChallenge(page)) {
      return { ready: false, action: 'cf-blocked', humanNeeded: true };
    }
    const submitted = await submitLoginForm(page);
    if (!submitted) return { ready: false, action: 'no-form', humanNeeded: true };
    if (await isLoggedIn(page)) return { ready: true, action: 'logged-in', humanNeeded: false };
    // Form submitted but session didn't come up — usually a wrong-creds or a
    // post-login challenge; a human in /warm can sort it out.
    return { ready: false, action: 'login-failed', humanNeeded: true };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// Polite 2–5s gap between requests. When a cancel `signal` is supplied, the gap
// resolves early on cancel so the next throwIfCancelled() aborts promptly instead
// of making the user wait out the delay. Callers without a signal (download /
// reupload / thanks) keep the original behaviour.
const randomDelay = (signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, 2000 + Math.floor(Math.random() * 3000));
    if (signal && typeof signal.onCancel === 'function') {
      signal.onCancel(() => { clearTimeout(t); resolve(); });
    }
  });

/**
 * Pull a short description blurb out of a Mobilism post's raw text.
 * Skips lines that look like metadata fields (Format:, Size:, etc.) or URLs.
 */
function extractBlurb(text, maxLen = 350) {
  if (!text) return '';
  const SKIP =
    /^(format|size|language|isbn|year|publisher|genre|source|type|pages|series|quality|author\(?s?\)?|title)[:：\s]/i;
  const lines = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (SKIP.test(line)) continue;
    if (/^https?:\/\//i.test(line)) continue;
    if (/mobilism\.org/i.test(line)) continue;
    out.push(line);
    if (out.join(' ').length >= maxLen) break;
  }
  const blurb = out.join(' ').trim();
  return blurb.length > maxLen ? blurb.slice(0, maxLen).trimEnd() + '…' : blurb;
}

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fuzzy/partial match: every token of the query must appear in the target at a
 * WORD START (prefix), not just anywhere as a substring. Word-start matching
 * keeps useful stem matches ("demon" → "demons") while rejecting the short-token
 * false positives that bare substring matching produced — e.g. "It Ends with Us"
 * decomposes into "it"/"us", and a naive includes() matched those inside
 * "wIThout"/"trUSt", letting unrelated posts pass. Tokens are normalized to
 * [a-z0-9] so they carry no regex metacharacters.
 */
function fuzzyMatch(query, target) {
  const q = normalize(query);
  if (!q) return true;
  const t = normalize(target);
  return q.split(' ').every((tok) => new RegExp('\\b' + tok).test(t));
}

/**
 * Fuzzy match against multi-line post content, requiring all tokens to appear
 * on the same line. Matching across the whole text lets short or common-word
 * titles ("It", "1984") false-positive on almost any collection post.
 */
function fuzzyMatchLine(query, text) {
  return (text || '').split(/\n+/).some((line) => fuzzyMatch(query, line));
}

function isCollection(title) {
  const t = (title || '').toLowerCase();
  return COLLECTION_KEYWORDS.some((kw) => t.includes(kw));
}

// Mobilism book topics declare the file format right in the title, e.g.
// "Title by Author (.ePUB)" or an audiobook "… (.M4B)". A format marker is a
// known extension preceded by "." "(" or "/" (so a stray "mobi" inside an
// ordinary word like "Mobile" doesn't count) — mirrors the authoritative title
// sniff fetchDetail() does on the topic page.
const TITLE_FORMAT_RE = /[.(/](epub|pdf|mobi|azw3?|cbr|cbz|djvu|m4b|m4a|mp3|aac|flac|ogg)\b/gi;

/**
 * True only when the title declares a NON-epub format and does NOT also declare
 * epub. Used to skip audiobook/PDF/etc. topics WITHOUT opening them — the big
 * win for "books by"/author searches, which otherwise navigate to every MP3/M4B
 * topic page just to read and discard its format. Titles that declare epub (even
 * alongside other formats) or declare no format at all are kept; the latter stay
 * lenient and are resolved by fetchDetail() as before.
 */
function titleDeclaresNonEpub(title) {
  const t = title || '';
  let m;
  let sawEpub = false;
  let sawOther = false;
  TITLE_FORMAT_RE.lastIndex = 0;
  while ((m = TITLE_FORMAT_RE.exec(t))) {
    if (m[1].toLowerCase() === 'epub') sawEpub = true;
    else sawOther = true;
  }
  return sawOther && !sawEpub;
}

function buildSearchUrl(keywords, { sd = 'd', titleOnly = false } = {}) {
  const params = new URLSearchParams({
    keywords: keywords || '',
    terms: 'all',
    sf: titleOnly ? 'titleonly' : 'all',
    sr: 'topics',
    sk: 't', // sort by post time
    sd, // d = newest first, a = oldest first
    submit: 'Search',
  });
  // Scope to the eBooks forum + subforums (mirrors the manual fid[]=106&sc=1
  // query). Without this, a term like "1984" matches across every section and
  // the target ebook is pushed past the page/detail caps.
  if (EBOOKS_FID) {
    params.append('fid[]', EBOOKS_FID);
    params.append('sc', '1');
    params.append('ch', '300');
  }
  return `${BASE_URL}/search.php?${params.toString()}`;
}

function toAbsolute(href) {
  try {
    return new URL(href, BASE_URL + '/').href;
  } catch {
    return href;
  }
}

function hostLabel(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return h.split('.')[0] || h;
  } catch {
    return 'link';
  }
}

// ---------------------------------------------------------------------------
// Scraping
// ---------------------------------------------------------------------------

/** Collect topic rows ({title, url}) across up to maxPages, following "next". */
async function collectRows(page, startUrl, maxPages, signal) {
  const rows = [];
  let url = startUrl;
  for (let i = 0; i < maxPages && url; i++) {
    throwIfCancelled(signal);
    await randomDelay(signal);
    throwIfCancelled(signal);
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const pageRows = await page.$$eval('td.expand a.topictitle', (els) =>
      els.map((a) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const td = a.closest('td');
        const small = td ? td.querySelector('small') : null;
        const forumA = td ? td.querySelector('a[href*="viewforum.php"]') : null;
        return {
          title: a.textContent.trim(),
          href: a.getAttribute('href'),
          date: small ? clean(small.textContent) : null,
          category: forumA ? clean(forumA.textContent) : null,
        };
      })
    );
    for (const r of pageRows) {
      rows.push({ title: r.title, url: toAbsolute(r.href), date: r.date, category: r.category });
    }

    // Find the "next page" link in the footer pagination.
    const nextHref = await page
      .$eval('a[rel="next"]', (a) => a.getAttribute('href'))
      .catch(async () => {
        return page
          .$$eval('.pagination a, .pagination li a', (els) => {
            const next = els.find((a) => /next|»|›/i.test(a.textContent));
            return next ? next.getAttribute('href') : null;
          })
          .catch(() => null);
      });
    url = nextHref ? toAbsolute(nextHref) : null;
  }
  return rows;
}

/** Open a topic page and scrape its first div.content for detail fields.
 *  `signal` (optional) makes the polite delay + navigation cancellable on the
 *  search path; the download path calls this without one. */
async function fetchDetail(page, topicUrl, signal) {
  throwIfCancelled(signal);
  await randomDelay(signal);
  throwIfCancelled(signal);
  await page.goto(topicUrl, { waitUntil: 'domcontentloaded' });

  const raw = await page.evaluate(() => {
    const content = document.querySelector('div.content');
    if (!content) return null;
    const img = content.querySelector('img');

    // Walk the content DOM in document order so each postlink gets tagged with
    // the nearest preceding section header (bold/strong text or text node).
    // In "Books by Author" collection posts, links are grouped under a book
    // title or its abbreviation (e.g. "TCC" for "The Calamity Club") — we
    // capture that context here so the downloader can filter by target book.
    const links = [];
    let currentSection = '';
    // A header is normal-length text OR a short colon-terminated label. The
    // colon clause is essential for single/double-letter book abbreviations like
    // "W:" (Whistler) or "TL:" — without it, those links inherit the PREVIOUS
    // section and a per-book download grabs the wrong book (or the all-books archive).
    const isHeader = (t) => t.length > 2 || /[:：]$/.test(t);
    (function walk(node) {
      if (!node) return;
      if (node.nodeType === 3) { // Text node
        const t = node.textContent.trim();
        if (isHeader(t)) currentSection = t;
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();
      if (tag === 'a' && node.classList && node.classList.contains('postlink')) {
        let premium = false;
        let n = node.nextElementSibling;
        for (let i = 0; n && i < 3; i++, n = n.nextElementSibling) {
          if (
            (n.matches && n.matches('img.MobilismDownloaderIcon')) ||
            (n.querySelector && n.querySelector('img.MobilismDownloaderIcon'))
          ) {
            premium = true;
            break;
          }
        }
        links.push({ url: node.href, premium, sectionHeader: currentSection });
        return; // don't recurse into the link itself
      }
      // Update section for header-like elements that don't themselves contain links
      if (['strong', 'b', 'em', 'h2', 'h3', 'h4'].includes(tag) && !node.querySelector('a.postlink')) {
        const t = node.textContent.trim();
        if (isHeader(t)) currentSection = t;
      }
      for (const child of node.childNodes) walk(child);
    })(content);

    const premium = !!document.querySelector('img.MobilismDownloaderIcon');

    const titleEl =
      document.querySelector('.page-category-topic h3 a') ||
      document.querySelector('.page-category-topic h3') ||
      document.querySelector('h3 a') ||
      document.querySelector('h2 a');
    const title = (titleEl ? titleEl.textContent : document.title.replace(/\s*\|\s*Mobilism\s*$/i, '')).trim();

    return {
      url: location.href,
      title,
      cover: img ? img.src : null,
      text: content.innerText || '',
      links,
      premium,
    };
  });

  if (!raw) return null;

  // An explicit format marker in the title (e.g. "(.MP3)") is authoritative;
  // only sniff the body when the title doesn't declare one — otherwise an
  // audiobook post whose body mentions "ePUB version" would slip through.
  const titleFmt = raw.title.match(/[.(](epub|pdf|mobi|azw3?|cbr|cbz|djvu|m4b|mp3|flac)\b/i);
  const blob = raw.text.toLowerCase();
  let format;
  if (titleFmt) format = titleFmt[1].toLowerCase() === 'epub' ? 'ePUB' : 'other';
  else if (blob.includes('epub')) format = 'ePUB';
  else if (/\b(pdf|mobi|azw3?|cbr|cbz|djvu|m4b|mp3|flac)\b/.test(blob)) format = 'other';
  else format = 'ePUB'; // format not stated anywhere — keep it (lenient)

  const sizeMatch = raw.text.match(/(\d+(?:\.\d+)?\s?(?:KB|MB|GB))/i);
  const authorMatch = raw.title.match(/\bby\s+(.+?)(?:\s*[([{]|\s*[-–—]|$)/i);

  // Deduplicate postlinks by href and attach a host label.
  const seenLinks = new Set();
  const postlinks = [];
  for (const l of raw.links) {
    if (seenLinks.has(l.url)) continue;
    seenLinks.add(l.url);
    postlinks.push({ host: hostLabel(l.url), url: l.url, premium: l.premium, sectionHeader: l.sectionHeader || '' });
  }

  return {
    url: raw.url,
    title: raw.title,
    cover: raw.cover,
    contentText: raw.text,
    description: extractBlurb(raw.text),
    format,
    size: sizeMatch ? sizeMatch[1] : null,
    author: authorMatch ? authorMatch[1].trim() : null,
    premium: raw.premium,
    postlinks,
  };
}

// `row` carries date + category scraped from the search-results listing, which
// is more reliable than the topic page.
function publicResult(detail, source, row = {}) {
  return {
    title: detail.title,
    author: detail.author,
    description: detail.description || '',
    format: 'ePUB',
    size: detail.size,
    date: row.date || null,
    category: row.category || null,
    source,
    url: detail.url,
    cover: detail.cover,
    premium: detail.premium,
    postlinks: detail.postlinks,
  };
}

/**
 * A result for a book found INSIDE a multi-book set/collection post. The post's
 * title (detail.title) names the SET and its cover is the set's first book — both
 * misleading for the single book the user wanted. We flag it `collection` and
 * carry the searched `matchedTitle`/`matchedAuthor` so the UI can foreground the
 * actual book (its own cover + blurb) and show the set only as provenance.
 */
function collectionResult(detail, row, matchedTitle, matchedAuthor) {
  return {
    ...publicResult(detail, 'Found in collection', row),
    collection: true,
    setTitle: detail.title,
    matchedTitle: (matchedTitle || '').trim(),
    matchedAuthor: (matchedAuthor || '').trim(),
  };
}

// ---------------------------------------------------------------------------
// Search orchestration
// ---------------------------------------------------------------------------
function search(params, onProgress, signal) {
  return enqueue(async () => {
    try {
      return await runSearch(params, onProgress, signal);
    } finally {
      // Once the search settles, a late client-disconnect must not fire stop()
      // on a page the next queued task has taken over.
      if (signal) signal.settle();
    }
  });
}

async function runSearch({ title, author, sort = 'newest' }, onProgress, signal) {
  if (!title && !author) throw new Error('At least one of title or author is required');
  // Cancelled while still queued? Don't even start.
  throwIfCancelled(signal);

  // Optional progress sink. Drives the live spinner text; never throws into the
  // scrape if a malformed handler is passed.
  const emit = (ev) => {
    try { if (typeof onProgress === 'function') onProgress(ev); } catch { /* ignore */ }
  };

  const sd = sort === 'oldest' ? 'a' : 'd';
  const { page } = await getSession();
  // Interrupt any in-flight navigation on cancel (the polite delays are handled
  // by randomDelay(signal); this catches a slow page load mid-goto).
  if (signal) signal.onCancel(() => { page.evaluate(() => window.stop()).catch(() => {}); });
  await ensureReady(page); // require a Mobilism login (throws needWarm if stale)
  const seen = new Set();
  const results = [];

  // Put title AND author in the first query when both are given — this mirrors
  // a manual titleonly search and lands directly on the match, instead of
  // searching the title alone and hoping the right post falls inside the caps.
  const pass1Keywords = [title, author].filter(Boolean).join(' ');
  const pass1Url = buildSearchUrl(pass1Keywords, { sd, titleOnly: !!title });
  const authorSearchUrl = author ? buildSearchUrl(author, { sd, titleOnly: false }) : null;

  // ---- Pass 1: title search ----
  emit({ phase: 'title-search' });
  const rows = await collectRows(page, pass1Url, MAX_PAGES, signal);
  const collections = [];

  for (const row of rows) {
    throwIfCancelled(signal);
    if (seen.has(row.url)) continue;
    if (title && !fuzzyMatch(title, row.title)) continue;
    // Skip MP3/M4B/PDF/etc. topics by their title alone — don't open them.
    if (titleDeclaresNonEpub(row.title)) continue;
    if (isCollection(row.title)) {
      collections.push(row);
      continue;
    }
    if (results.length >= DETAIL_CAP) break;
    seen.add(row.url);
    emit({ phase: 'scanning', found: results.length });
    const detail = await fetchDetail(page, row.url, signal);
    if (!detail || detail.format !== 'ePUB') continue;
    if (
      author &&
      detail.author &&
      !fuzzyMatch(author, detail.author) &&
      !fuzzyMatch(author, detail.title)
    ) {
      continue;
    }
    results.push(publicResult(detail, 'Direct match', row));
  }

  // ---- Collection crawl (max 3) ----
  if (collections.length) emit({ phase: 'collections' });
  for (const col of collections.slice(0, MAX_COLLECTIONS)) {
    throwIfCancelled(signal);
    if (seen.has(col.url)) continue;
    if (titleDeclaresNonEpub(col.title)) continue; // skip audiobook/PDF collections
    seen.add(col.url);
    const detail = await fetchDetail(page, col.url, signal);
    if (!detail) continue;
    const blob = detail.contentText.toLowerCase();
    if (!blob.includes('epub')) continue;
    if (title && !fuzzyMatchLine(title, detail.contentText)) continue;
    results.push(collectionResult(detail, col, title, author));
  }

  // ---- "Books by {author}" collection pass ----
  // A second search that targets multi-book set/collection posts (titled like
  // "Books by Sally Hepworth"), then scans each post's contents for the
  // requested title. Always runs when both title and author are given; its
  // results are merged with everything above and deduped via `seen`.
  if (title && author) {
    emit({ phase: 'author-collections' });
    const byAuthorUrl = buildSearchUrl(`books by ${author}`, { sd, titleOnly: true });
    const byAuthorRows = await collectRows(page, byAuthorUrl, COLLECTION_SEARCH_PAGES, signal);
    let scanned = 0;
    for (const row of byAuthorRows) {
      throwIfCancelled(signal);
      if (seen.has(row.url)) continue;
      if (titleDeclaresNonEpub(row.title)) continue; // skip audiobook/PDF sets
      if (scanned >= MAX_AUTHOR_COLLECTION_SCAN) break;
      seen.add(row.url);
      scanned++;
      const detail = await fetchDetail(page, row.url, signal);
      if (!detail) continue;
      // The set must list the requested title (on a single line) and offer ePUB.
      if (!detail.contentText.toLowerCase().includes('epub')) continue;
      if (!fuzzyMatchLine(title, detail.contentText)) continue;
      results.push(collectionResult(detail, row, title, author));
    }
  }

  // ---- Author fallback (last resort — only if nothing turned up at all) ----
  if (results.length === 0 && author) {
    emit({ phase: 'author-fallback' });
    // Search the author title-only (sf=titleonly): book posts are titled
    // "Title by Author (.ePUB)", so the author lands in the title. An all-fields
    // search instead returns every post that merely *mentions* the author in its
    // blurb — comp-title marketing like "for fans of Colleen Hoover" — which is
    // exactly how unrelated books leaked into this pass.
    const fallbackUrl = buildSearchUrl(author, { sd, titleOnly: true });
    const arows = await collectRows(page, fallbackUrl, MAX_PAGES, signal);
    let colCount = 0;
    for (const row of arows) {
      throwIfCancelled(signal);
      if (seen.has(row.url)) continue;
      if (titleDeclaresNonEpub(row.title)) continue; // skip MP3/M4B/PDF without opening
      // A title was entered, so only open a non-collection author post when its
      // title is plausibly the requested book. Mobilism titles posts "Title by
      // Author (.ePUB)", so the title should be in the row title — if it isn't,
      // this is a DIFFERENT book by the author and we skip it WITHOUT opening the
      // thread (the VNC no longer walks every author post). Collections carry no
      // title in their name, so they're still opened (capped) and scanned inside.
      if (title && !isCollection(row.title) && !fuzzyMatch(title, row.title)) continue;
      if (isCollection(row.title)) {
        if (colCount >= MAX_COLLECTIONS) continue;
        colCount++;
      }
      if (results.length >= DETAIL_CAP) break;
      seen.add(row.url);
      emit({ phase: 'scanning', found: results.length });
      const detail = await fetchDetail(page, row.url, signal);
      if (!detail || detail.format !== 'ePUB') continue;
      // Require the post's ACTUAL author (parsed from "… by <author>" in the
      // title) to match. Without this, a body mention of the author was enough
      // to pass — the root cause of "It Ends with Us / Colleen Hoover" returning
      // "Loving with Demons by Hana Mahmood".
      if (
        detail.author &&
        !fuzzyMatch(author, detail.author) &&
        !fuzzyMatch(author, detail.title)
      ) {
        continue;
      }
      if (
        title &&
        !fuzzyMatchLine(title, detail.contentText) &&
        !fuzzyMatch(title, detail.title)
      ) {
        continue;
      }
      results.push(publicResult(detail, 'Author fallback', row));
    }
  }

  return {
    results,
    // Only offer a manual title link when a title was actually entered;
    // otherwise pass 1 was an author search and the link would be a duplicate.
    fallbackLinks: { title: title ? pass1Url : null, author: authorSearchUrl },
  };
}

module.exports = {
  BASE_URL,
  search,
  getSession,
  closeSession,
  sessionStatus,
  ensureReady,
  warmUp,
  enqueue,
  randomDelay,
  fetchDetail,
  createCancelSignal,
  CancelledError,
  // exported for unit tests
  normalize,
  fuzzyMatch,
  fuzzyMatchLine,
  isCollection,
  titleDeclaresNonEpub,
  collectionResult,
  throwIfCancelled,
};
