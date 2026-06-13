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
// Helpers
// ---------------------------------------------------------------------------
const randomDelay = () =>
  new Promise((r) => setTimeout(r, 2000 + Math.floor(Math.random() * 3000))); // 2–5s

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fuzzy/partial match: every token of the query appears somewhere in target. */
function fuzzyMatch(query, target) {
  const q = normalize(query);
  if (!q) return true;
  const t = normalize(target);
  return q.split(' ').every((tok) => t.includes(tok));
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
async function collectRows(page, startUrl, maxPages) {
  const rows = [];
  let url = startUrl;
  for (let i = 0; i < maxPages && url; i++) {
    await randomDelay();
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

/** Open a topic page and scrape its first div.content for detail fields. */
async function fetchDetail(page, topicUrl) {
  await randomDelay();
  await page.goto(topicUrl, { waitUntil: 'domcontentloaded' });

  const raw = await page.evaluate(() => {
    const content = document.querySelector('div.content');
    if (!content) return null;
    const img = content.querySelector('img');
    // The premium icon, when present, is rendered adjacent to its postlink, so
    // tag each link with whether an icon sits within its next few siblings.
    const links = Array.from(document.querySelectorAll('a.postlink')).map((a) => {
      let premium = false;
      let n = a.nextElementSibling;
      for (let i = 0; n && i < 3; i++, n = n.nextElementSibling) {
        if (
          (n.matches && n.matches('img.MobilismDownloaderIcon')) ||
          (n.querySelector && n.querySelector('img.MobilismDownloaderIcon'))
        ) {
          premium = true;
          break;
        }
      }
      return { url: a.href, premium };
    });
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
    postlinks.push({ host: hostLabel(l.url), url: l.url, premium: l.premium });
  }

  return {
    url: raw.url,
    title: raw.title,
    cover: raw.cover,
    contentText: raw.text,
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

// ---------------------------------------------------------------------------
// Search orchestration
// ---------------------------------------------------------------------------
function search(params) {
  return enqueue(() => runSearch(params));
}

async function runSearch({ title, author, sort = 'newest' }) {
  if (!title && !author) throw new Error('At least one of title or author is required');

  const sd = sort === 'oldest' ? 'a' : 'd';
  const { page } = await getSession();
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
  const rows = await collectRows(page, pass1Url, MAX_PAGES);
  const collections = [];

  for (const row of rows) {
    if (seen.has(row.url)) continue;
    if (title && !fuzzyMatch(title, row.title)) continue;
    if (isCollection(row.title)) {
      collections.push(row);
      continue;
    }
    if (results.length >= DETAIL_CAP) break;
    seen.add(row.url);
    const detail = await fetchDetail(page, row.url);
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
  for (const col of collections.slice(0, MAX_COLLECTIONS)) {
    if (seen.has(col.url)) continue;
    seen.add(col.url);
    const detail = await fetchDetail(page, col.url);
    if (!detail) continue;
    const blob = detail.contentText.toLowerCase();
    if (!blob.includes('epub')) continue;
    if (title && !fuzzyMatchLine(title, detail.contentText)) continue;
    results.push(publicResult(detail, 'Found in collection', col));
  }

  // ---- "Books by {author}" collection pass ----
  // A second search that targets multi-book set/collection posts (titled like
  // "Books by Sally Hepworth"), then scans each post's contents for the
  // requested title. Always runs when both title and author are given; its
  // results are merged with everything above and deduped via `seen`.
  if (title && author) {
    const byAuthorUrl = buildSearchUrl(`books by ${author}`, { sd, titleOnly: true });
    const byAuthorRows = await collectRows(page, byAuthorUrl, COLLECTION_SEARCH_PAGES);
    let scanned = 0;
    for (const row of byAuthorRows) {
      if (seen.has(row.url)) continue;
      if (scanned >= MAX_AUTHOR_COLLECTION_SCAN) break;
      seen.add(row.url);
      scanned++;
      const detail = await fetchDetail(page, row.url);
      if (!detail) continue;
      // The set must list the requested title (on a single line) and offer ePUB.
      if (!detail.contentText.toLowerCase().includes('epub')) continue;
      if (!fuzzyMatchLine(title, detail.contentText)) continue;
      results.push(publicResult(detail, 'Found in collection', row));
    }
  }

  // ---- Author fallback (last resort — only if nothing turned up at all) ----
  if (results.length === 0 && author) {
    const arows = await collectRows(page, authorSearchUrl, MAX_PAGES);
    let colCount = 0;
    for (const row of arows) {
      if (seen.has(row.url)) continue;
      if (isCollection(row.title)) {
        if (colCount >= MAX_COLLECTIONS) continue;
        colCount++;
      }
      if (results.length >= DETAIL_CAP) break;
      seen.add(row.url);
      const detail = await fetchDetail(page, row.url);
      if (!detail || detail.format !== 'ePUB') continue;
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
  enqueue,
  randomDelay,
  fetchDetail,
  // exported for unit tests
  normalize,
  fuzzyMatch,
  fuzzyMatchLine,
  isCollection,
};
