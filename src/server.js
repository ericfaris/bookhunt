'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const httpProxy = require('http-proxy');

const searcher = require('./searcher');
const downloader = require('./downloader');
const history = require('./history');
const amazon = require('./amazon');
const recipients = require('./recipients');
const notify = require('./notify');
const kindle = require('./kindle');
const security = require('./security');
const reupload = require('./reupload');
const reuploads = require('./reuploads');
const library = require('./library');
const booktags = require('./booktags');
const covers = require('./covers');
const messages = require('./messages');
const batch = require('./batch');
const correct = require('./correct');
const sources = require('./sources');
const health = require('./health');
const version = require('./version');
const autowarm = require('./autowarm');
const watchlist = require('./watchlist');
const watcher = require('./watcher');
const settings = require('./settings');
const lists = require('./lists');
const listwatcher = require('./listwatcher');
const reader = require('./reader');

const PORT = process.env.PORT || 3000;
const app = express();

// True only for http(s) URLs on the Mobilism forum host — keeps the
// browser-navigating endpoints (/api/download, /api/reupload) from being
// pointed at an attacker-chosen origin while carrying our session cookies.
const isForumUrl = security.isForumUrl;

// Don't advertise the framework, and reject oversized bodies (all real requests
// here are tiny JSON — capping blunts memory-exhaustion attempts).
app.disable('x-powered-by');

// Security headers (CSP, anti-clickjacking, no-sniff) on every response.
app.use(security.securityHeaders);

// Verify the Cloudflare Access JWT at the origin so the app FAILS CLOSED even if
// someone reaches the tunnel directly or the Access policy is ever loosened.
// No-op until CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD are set (see .env.example).
// Mounted before everything so it also gates /warm (the live browser) + statics.
app.use(security.cloudflareAccess());

app.use(express.json({ limit: '64kb' }));

// Per-IP rate limit on the API. Generous enough for normal use (searches and
// downloads are few and slow) but caps hammering/abuse if the front gate fails.
app.use('/api', security.rateLimiter({ windowMs: 60_000, max: 120 }));

// --- Reader portal (issue #34) ----------------------------------------------
// Magic-link book picker for recipients — the ONLY surface outside Cloudflare
// Access (path-scoped CF bypass app at the edge; cloudflareAccess() skips it
// origin-side). Auth = per-recipient token, resolved constant-time; invalid
// tokens 404 so the route doesn't confirm which tokens exist. Tighter rate
// limit than the operator API: readers browse and tap, they don't hammer.
app.use('/reader', security.rateLimiter({ windowMs: 60_000, max: 40 }));

// Reader API responses are personal (name, books, sent-state) and the URLs
// carry the token — never let a browser or intermediary cache them.
app.use('/reader/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/reader', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', 'public', 'reader.html'));
});

// The page's script must live under /reader/* too — anywhere else and the CF
// Access wall (which readers can't pass) would block it.
app.get('/reader/app.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', 'public', 'reader.js'));
});

// Per-reader web app manifest (home-screen install). Token from the query is
// baked into start_url so the installed icon opens THIS reader's shelf. Must
// live under /reader/* to clear Cloudflare Access.
app.get('/reader/manifest.webmanifest', (req, res) => {
  const r = reader.byToken(String(req.query.t || ''));
  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Cache-Control', 'no-cache');
  res.json(reader.buildManifest(r ? r.readerToken : ''));
});

// App icons for the home-screen install — also under /reader/* for CF Access.
app.get('/reader/icon-:size.png', (req, res) => {
  const size = ['180', '192', '512'].includes(req.params.size) ? req.params.size : '192';
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, '..', 'public', `reader-icon-${size}.png`));
});

app.get('/reader/api/books', async (req, res) => {
  const r = reader.byToken(String(req.query.t || ''));
  if (!r) return res.status(404).json({ error: 'Not found' });
  try {
    const books = await reader.booksForReader(r);
    res.json({ name: r.name, kindleSet: !!r.kindleEmail, days: reader.RECENT_DAYS, books });
  } catch (err) {
    console.error('Reader books failed:', err);
    res.status(500).json({ error: 'Could not load the shelf.' });
  }
});

app.post('/reader/api/send', async (req, res) => {
  const { t, id } = req.body || {};
  const r = reader.byToken(String(t || ''));
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Missing book id.' });
  try {
    const out = await reader.sendToReader(r, id);
    res.json({ ok: true, title: out.title });
  } catch (err) {
    const status = err.code === 'no-kindle' ? 409 : err.code === 'gone' ? 410 : err.code === 'throttled' ? 429 : 500;
    if (status === 500) console.error('Reader send failed:', err);
    res.status(status).json({ error: err.message });
  }
});

app.post('/reader/api/unsubscribe', (req, res) => {
  const r = reader.byToken(String((req.body || {}).t || ''));
  if (!r) return res.status(404).json({ error: 'Not found' });
  reader.setReaderEnabled(r.id, false);
  res.json({ ok: true });
});

// --- /warm: live browser view (noVNC) --------------------------------------
// The container runs Chromium headed under Xvfb; x11vnc + websockify expose it
// on :6080. We proxy it under /warm so it rides the SAME hostname + Cloudflare
// Access policy as the app (no extra tunnel ingress, no second Access app).
// Open /warm to see the real browser and clear Mobilism's Cloudflare challenge.
const NOVNC_TARGET = 'http://127.0.0.1:6080';
const warmProxy = httpProxy.createProxyServer({ target: NOVNC_TARGET, ws: true });
warmProxy.on('error', (err, _req, res) => {
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('warm view not reachable: ' + err.message);
  }
});

// Land on the full noVNC client, auto-connecting to the in-container VNC.
app.get('/warm', (_req, res) =>
  res.redirect('/warm/vnc.html?path=warm/websockify&autoconnect=true&resize=scale&reconnect=true')
);
// express strips the /warm mount prefix from req.url, so assets resolve at the
// websockify web root.
app.use('/warm', (req, res) => warmProxy.web(req, res));

// Serve the app shell with `no-cache` on HTML/JS/CSS so a redeploy is picked up
// immediately. The browser may still STORE these, but must revalidate against
// the origin first — ETag turns the check into a cheap 304 when unchanged. This
// prevents a stale app.js running against a freshly-updated index.html after a
// deploy (the cause of "the new button does nothing"). Other assets cache normally.
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    setHeaders(res, filePath) {
      if (/\.(html|js|css)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
      // PWA (issue #18): the service worker must never be stale, and some setups
      // don't map .webmanifest to the right content type.
      if (/sw\.js$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
      if (/\.webmanifest$/i.test(filePath)) {
        res.setHeader('Content-Type', 'application/manifest+json');
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

// --- Session status (drives the re-warm banner) ----------------------------
app.get('/api/session/status', async (_req, res) => {
  try {
    res.json(await searcher.sessionStatus());
  } catch (err) {
    res.status(500).json({ error: err.message, ready: false });
  }
});

// Manual fallback for the "Log into Mobilism" button: fill + submit the login on
// the LIVE browser using env creds (the same thing the auto-warm watcher does on
// its own). Used after a human has cleared an interactive Cloudflare challenge in
// /warm so they never have to type the password into noVNC. Returns the result of
// the attempt plus the resulting session status.
app.post('/api/session/login', async (_req, res) => {
  try {
    const result = await searcher.warmUp();
    res.json({ ...result, session: await searcher.sessionStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message, ready: false });
  }
});

// --- Search -----------------------------------------------------------------
// Streamed as Server-Sent Events. A Mobilism scrape can run for minutes (polite
// 2–5s delays between many requests), which is well past Cloudflare's 100s
// origin timeout — a plain JSON response would get replaced by Cloudflare's HTML
// 524 page and the client would choke on `JSON.parse('<!DOCTYPE …')`. Streaming
// flushes headers immediately and a heartbeat keeps bytes flowing, so the edge
// never times out. Progress events drive the live spinner; the terminal
// `done`/`error` frame carries the payload (results or a needWarm signal).
app.post('/api/search', async (req, res) => {
  let { title, author, sort } = req.body || {};
  // Coerce + bound the free-text inputs so a hostile client can't push huge or
  // non-string values into the scraper/query builder.
  title = typeof title === 'string' ? title.slice(0, 300) : '';
  author = typeof author === 'string' ? author.slice(0, 300) : '';
  if (sort !== 'oldest') sort = 'newest'; // only two valid sorts
  if (!title && !author) {
    return res.status(400).json({ error: 'Enter a title and/or an author.' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering so events flush promptly
  });
  const send = (event) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
  // Comment-frame heartbeat (every 15s) keeps the connection alive across the
  // long gaps between page fetches so Cloudflare's 524 timeout never fires.
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);

  // Cancellation (issue #28): cancel ONLY when the client truly disconnects
  // mid-stream. Listen on the RESPONSE close (not req 'close', which also fires
  // when the request body finishes being read — and does so early behind
  // Cloudflare — spuriously cancelling every search). `writableEnded` is true
  // once we've called res.end() ourselves, so a normal finish never cancels.
  const signal = searcher.createCancelSignal();
  res.on('close', () => { if (!res.writableEnded) signal.cancel(); });

  try {
    // Fuzzy spell-correction BEFORE the scrape: a misspelled request yields bad
    // or empty Mobilism results, so fix the title/author against an external book
    // repo first (fail-open — never blocks the search). On a confident fix, swap
    // in the clean spelling, tell the client (before→after), and search/log with
    // the corrected terms so History + the Library stay clean.
    const fix = await correct.correct({ title, author });
    if (fix.corrected) {
      title = fix.title;
      author = fix.author;
      send({ step: 'corrected', original: fix.original, title, author, source: fix.source });
    }

    // Stage 1 — check the local Library first. If we already own this book,
    // surface it immediately (with its send history) so the user sees they have
    // it — and to whom it's gone — before the slower Mobilism scrape even starts.
    // Local + instant; runs even if the Mobilism session is stale. Fail-soft.
    try {
      const libBooks = library.buildLibrary(history.readAll(), (p) => {
        try { return fs.existsSync(path.resolve(p)); } catch { return false; }
      });
      const hits = library.findInLibrary(libBooks, { title, author }).slice(0, 3);
      if (hits.length) send({ step: 'library', books: hits });
    } catch (err) {
      console.error('Library pre-search failed:', err.message);
    }

    const { results, fallbackLinks } = await searcher.search(
      { title, author, sort },
      (ev) => send({ step: 'progress', ...ev }),
      signal
    );
    history.logSearch({ title, author, sort, resultCount: results.length });
    // External fallback sources (issue #19) — shown only when nothing matched.
    send({ step: 'done', results, fallbackLinks, externalSources: sources.buildSources({ title, author }) });
  } catch (err) {
    // A cancellation isn't an error — the client already walked away, so there's
    // nothing (and nowhere) to report.
    if (!err || !err.cancelled) {
      console.error('Search failed:', err);
      const info = messages.classifyError(err, { needWarm: !!err.needWarm });
      send({ step: 'error', ...info });
    }
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
});

// --- Batch search -----------------------------------------------------------
// Searches a pasted list of books in one pass. Streamed as SSE for the same
// reason as /api/search (each entry is a full scrape; the whole batch is well
// past Cloudflare's 100s timeout). Searches run sequentially through the shared
// browser queue (searcher.search → enqueue), one entry never aborts the rest
// (batch.runSequential isolates failures), and the session is preflighted once
// so a stale session fails fast as a single 409 instead of per-entry stalls.
app.post('/api/search/batch', async (req, res) => {
  const text = typeof (req.body && req.body.text) === 'string' ? req.body.text : '';
  const sort = (req.body && req.body.sort) === 'oldest' ? 'oldest' : 'newest';
  const entries = batch.parseBatchInput(text);
  if (!entries.length) {
    return res.status(400).json({ error: 'Enter at least one book (one per line).' });
  }

  // Preflight the session: if it's stale, don't attempt N logins — tell the
  // client to re-warm once, up front.
  try {
    const status = await searcher.sessionStatus();
    if (!status.ready) {
      return res.status(409).json({ error: 'Mobilism session expired — re-warm, then run the batch.', needWarm: true });
    }
  } catch {
    /* fall through — the per-entry searches will surface a real error */
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);

  // Cancellation (same posture as /api/search): a batch is a long sequence of
  // per-entry scrapes, so when the client truly disconnects mid-stream we must
  // stop — otherwise the batch "goes rogue" and keeps scraping after the page is
  // closed/refreshed. `batchCancelled` halts runSequential at the next entry
  // boundary; `currentSignal` aborts the entry currently in flight (its polite
  // delay + any live navigation). Guarded by writableEnded so our own res.end()
  // never trips it.
  let batchCancelled = false;
  let currentSignal = null;
  res.on('close', () => {
    if (res.writableEnded) return;
    batchCancelled = true;
    if (currentSignal) currentSignal.cancel();
  });

  // Per-entry worker: spell-correct first (fail-open), then search. A search
  // error becomes a classified outcome (not a throw) so it's reported inline and
  // the batch keeps going. The correction (if any) rides along in the outcome so
  // the row can show before→after and download/log with the corrected spelling.
  const worker = async (entry, i) => {
    const index = i + 1;
    const fix = await correct.correct({ title: entry.title, author: entry.author });
    const corrected = fix.corrected
      ? { corrected: true, original: fix.original, title: fix.title, author: fix.author, source: fix.source }
      : { corrected: false };
    // Per-entry cancel signal: searcher.search() settles it in its own finally,
    // so each entry needs a fresh one (a settled signal can't fire cancel).
    const signal = searcher.createCancelSignal();
    currentSignal = signal;
    // Forward the scrape's phase events to THIS row so each book shows live
    // movement (mirrors the single-search progress line).
    const onProgress = (ev) => send({ step: 'progress', index, total: entries.length, ...ev });
    try {
      const { results, fallbackLinks } = await searcher.search({
        title: fix.title,
        author: fix.author,
        sort,
      }, onProgress, signal);
      return { ...batch.classifyBatchOutcome({ results }), results, fallbackLinks, ...corrected };
    } catch (err) {
      if (err && err.cancelled) throw err; // bubble up so runSequential stops the batch
      const info = messages.classifyError(err, { needWarm: !!err.needWarm });
      return { status: 'error', error: info.message, hint: info.hint, needWarm: info.needWarm, ...corrected };
    } finally {
      currentSignal = null;
    }
  };

  try {
    send({ step: 'start', total: entries.length, entries });
    const outcomes = await batch.runSequential(entries, worker, (ev) => {
      if (ev.phase === 'start') {
        send({ step: 'searching', index: ev.index, total: ev.total, title: ev.item.title });
      } else if (ev.phase === 'ok') {
        send({ step: 'entry', index: ev.index, total: ev.total, ...ev.value });
      }
    }, () => !batchCancelled);
    const found = outcomes.filter((o) => o.ok && o.value && (o.value.status === 'found' || o.value.status === 'multiple')).length;
    history.logSearch({ title: `Batch (${entries.length} books)`, author: '', sort, resultCount: found });
    send({ step: 'done', total: entries.length, found });
  } catch (err) {
    console.error('Batch search failed:', err);
    const info = messages.classifyError(err, { needWarm: !!err.needWarm });
    send({ step: 'error', ...info });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// --- Amazon link → title/author -------------------------------------------
app.post('/api/amazon', async (req, res) => {
  const { url } = req.body || {};
  if (!url || !amazon.isAmazonUrl(url)) {
    return res.status(400).json({ error: 'Please provide a valid Amazon link.' });
  }
  try {
    const data = await amazon.lookup(url);
    if (!data.title && !data.author) {
      return res.status(422).json({ error: 'Could not read title/author from that Amazon page.' });
    }
    res.json(data);
  } catch (err) {
    console.error('Amazon lookup failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Premium credentials (in-memory, per session) ---------------------------
app.get('/api/premium/status', (_req, res) => {
  res.json({ hasCreds: downloader.hasPremiumCreds() });
});

app.post('/api/premium/creds', (req, res) => {
  const { user, pass } = req.body || {};
  if (!user || !pass) return res.status(400).json({ error: 'Username and password required.' });
  downloader.setPremiumCreds(user, pass);
  res.json({ ok: true });
});

// --- Download (premium path) ------------------------------------------------
// Streamed as Server-Sent Events: the download takes seconds-to-minutes and the
// UI shows each step live (login → mirror → download → verify). The creds check
// stays a normal 401 (the client checks /api/premium/status first); everything
// after the stream opens — including needWarm and fatal errors — is delivered as
// an SSE `error` event, since the HTTP status is already committed.
// Bound how many candidate posts one download request may walk (batch mode
// sends every match for an entry) — each is a full scrape, so cap the work.
const MAX_DOWNLOAD_CANDIDATES = 10;

app.post('/api/download', async (req, res) => {
  const { url, title, searchedTitle, author, cover, candidates } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing post url.' });
  // The topic URL is navigated to in the authenticated browser session, so only
  // allow forum (mobilism.org) http(s) URLs — never an attacker-chosen origin.
  if (!isForumUrl(url)) {
    return res.status(400).json({ error: 'Refusing that URL — must be a Mobilism forum link.' });
  }
  // Optional fallback candidates (batch mode): the OTHER search matches for the
  // same entry, tried in order when a post yields no verified, title-matching
  // download. Each is navigated in the same authenticated session, so every one
  // gets the same forum-only guard as the primary URL.
  const posts = [{ url, title: typeof title === 'string' ? title : '' }];
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const cUrl = c && typeof c.url === 'string' ? c.url : '';
    if (!cUrl || posts.some((p) => p.url === cUrl)) continue;
    if (!isForumUrl(cUrl)) {
      return res.status(400).json({ error: 'Refusing a candidate URL — must be a Mobilism forum link.' });
    }
    posts.push({ url: cUrl, title: typeof c.title === 'string' ? c.title.slice(0, 300) : '' });
    if (posts.length >= MAX_DOWNLOAD_CANDIDATES) break;
  }
  if (!downloader.hasPremiumCreds()) {
    return res.status(401).json({ error: 'Premium credentials required.', needCreds: true });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering so events flush promptly
  });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  try {
    // Walk the candidate posts until one yields a VERIFIED, title-matching
    // download (runCandidates keeps the best fallback when none verifies).
    // Progress events — including per-candidate 'candidate' frames — stream
    // straight through to the client.
    const { result, errors } = await downloader.runCandidates(
      posts,
      (cand) => downloader.premiumDownload(cand.url, send, searchedTitle || title),
      send
    );
    const downloads = (result && result.downloads) || [];
    // The cover passed from the client is scraped from the forum post's first
    // image, which is unreliable — for a multi-book set post it's a DIFFERENT
    // book (the bug that put "The Dead Romantics" on "The Someday Garden"). Prefer
    // a title+author-verified catalog cover (gated + disk-cached); fall back to
    // the scraped one only when the catalog has nothing.
    const bookTitle = searchedTitle || title || (result && result.title);
    let resolvedCover = cover || null;
    try {
      const catalogCover = await covers.resolveCover({ title: bookTitle, author });
      if (catalogCover) resolvedCover = catalogCover;
    } catch { /* keep the scraped cover */ }
    for (const d of downloads) {
      const stored = history.logDownload({
        title: searchedTitle || title || (result && result.title),
        author: author || '',
        cover: resolvedCover,
        filename: d.filename,
        savePath: d.savePath,
        url: d.url,
        mode: 'premium',
        verified: d.verified,
        size: d.size,
      });
      d.id = stored.id; // safe handle the client passes back to /api/send
    }
    send({
      step: 'done',
      downloads,
      errors,
      title: (result && result.title) || title || '',
      description: (result && result.description) || '',
    });
  } catch (err) {
    console.error('Download failed:', err.detail || err); // full text kept server-side
    const info = messages.classifyError(err, { needWarm: !!err.needWarm });
    send({ step: 'error', ...info });
  } finally {
    res.end();
  }
});

// --- Standard download logging (links opened client-side) -------------------
app.post('/api/download/standard', (req, res) => {
  const { url, host, title, author, cover } = req.body || {};
  history.logDownload({ title, author: author || '', cover: cover || null, filename: host || 'external link', savePath: null, url, mode: 'standard' });
  res.json({ ok: true });
});

// --- Request a re-upload ----------------------------------------------------
// Asks the original poster to re-upload a book whose links have gone stale,
// using the existing authenticated forum session. The topic URL is navigated to
// in that session, so it must be a Mobilism forum link (same SSRF guard as
// /api/download). Distinct outcomes are mapped to plain-language messages:
//   success / already-requested / not-available / unknown — and a stale session
// (needWarm) becomes a 409 that the UI turns into a "re-warm" prompt.
app.post('/api/reupload', async (req, res) => {
  const { url, title } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing topic url.' });
  if (!isForumUrl(url)) {
    return res.status(400).json({ error: 'Refusing that URL — must be a Mobilism forum link.' });
  }
  try {
    const outcome = await reupload.requestReupload(url);
    // Note it in history so the request is visible later; failures to log are
    // non-fatal to the response.
    try {
      history.add({ type: 'reupload', title: title || '', url, status: outcome.status });
    } catch { /* best effort */ }
    res.json(outcome);
  } catch (err) {
    console.error('Re-upload request failed:', err);
    if (err.needWarm) {
      return res.status(409).json({ error: err.message, needWarm: true });
    }
    res.status(500).json({ error: err.message || 'Re-upload request failed.' });
  }
});

// --- Re-upload request management (issue #27) -------------------------------
// Mobilism's UCP page is authoritative; we annotate with local history so a row
// can deep-link back to the in-app book/thread. A stale session becomes a 409
// the UI turns into a re-warm prompt (same as /api/reupload).
app.get('/api/reupload/requests', async (_req, res) => {
  try {
    const data = await reuploads.listRequests();
    const reupHistory = history.readAll().filter((e) => e.type === 'reupload');
    res.json({ ...data, history: reupHistory });
  } catch (err) {
    console.error('Re-upload requests load failed:', err);
    if (err.needWarm) return res.status(409).json({ error: err.message, needWarm: true });
    res.status(500).json({ error: err.message || 'Could not load re-upload requests.' });
  }
});

app.post('/api/reupload/cancel', async (req, res) => {
  const { releaseNames } = req.body || {};
  if (!Array.isArray(releaseNames) || !releaseNames.length) {
    return res.status(400).json({ error: 'No requests selected to cancel.' });
  }
  try {
    const result = await reuploads.cancelRequests(releaseNames.map(String).slice(0, 50));
    res.json(result);
  } catch (err) {
    console.error('Re-upload cancel failed:', err);
    if (err.needWarm) return res.status(409).json({ error: err.message, needWarm: true });
    res.status(500).json({ error: err.message || 'Could not cancel the request(s).' });
  }
});

// --- Watchlist (issue #7) ---------------------------------------------------
// Saved searches the server re-runs on a schedule (src/watcher.js), notifying
// the user when a match finally appears. The list also reports whether email is
// configured (no email channel = notifications can't be delivered).
app.get('/api/watchlist', (_req, res) => {
  res.json({
    watches: watchlist.readAll(),
    emailReady: notify.listChannels().some((c) => c.id === 'email' && c.configured),
    notifyTo: watcher.operatorEmail() || null,
    // For relating recipients to a watch (id, name, whether they have a Kindle).
    recipients: recipients.readAll().map((r) => ({ id: r.id, name: r.name, hasKindle: !!r.kindleEmail })),
  });
});

app.post('/api/watchlist', (req, res) => {
  try {
    const entry = watchlist.add(req.body || {});
    res.json(entry);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not add the watch.' });
  }
});

app.delete('/api/watchlist/:id', (req, res) => {
  const ok = watchlist.remove(req.params.id);
  res.json({ ok });
});

// Pause / resume a watch.
app.post('/api/watchlist/:id/status', (req, res) => {
  try {
    const updated = watchlist.setStatus(req.params.id, (req.body || {}).status);
    if (!updated) return res.status(404).json({ error: 'Watch not found.' });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Relate recipients to a watch — who gets the book on Kindle + a notification
// when it's found (issue #7 follow-up).
app.post('/api/watchlist/:id/recipients', (req, res) => {
  const updated = watchlist.setRecipients(req.params.id, (req.body || {}).recipientIds);
  if (!updated) return res.status(404).json({ error: 'Watch not found.' });
  res.json(updated);
});

// "Check now" — run this watch immediately instead of waiting for the scheduler.
app.post('/api/watchlist/:id/check', async (req, res) => {
  try {
    const result = await watcher.checkNow(req.params.id);
    res.json(result);
  } catch (err) {
    if (err.needWarm) return res.status(409).json({ error: err.message, needWarm: true });
    res.status(500).json({ error: err.message || 'Check failed.' });
  }
});

// --- History ----------------------------------------------------------------
app.get('/api/history', (_req, res) => {
  res.json({ entries: history.readAll() });
});

// --- Library: book-centric view with inline send history -------------------
// Reshapes the flat history into one row per downloaded book, each carrying its
// sends. `filePresent` reflects whether the .epub is still on disk so the client
// can disable resend for files that have been removed.
app.get('/api/library', (_req, res) => {
  const books = library.buildLibrary(history.readAll(), (p) => {
    try {
      return fs.existsSync(path.resolve(p));
    } catch {
      return false;
    }
  });
  const store = booktags.readStore();
  res.json({ books: booktags.attachTags(books, store), allTags: booktags.allTags(store) });
});

// Delete a library book: remove its file from disk (when safe + present) and
// drop its download + correlated send entries from history. Tags for that file
// are dropped too. Idempotent-ish: a missing file still clears the history rows.
app.delete('/api/library/:id', (req, res) => {
  let savePath = null;
  let removed = false;
  history.mutate((entries) => {
    const r = library.removeBook(entries, req.params.id);
    savePath = r.savePath;
    removed = r.removed;
    return removed ? r.entries : false; // nothing found → don't rewrite the file
  });
  if (!removed) return res.status(404).json({ error: 'Library book not found.' });
  let fileDeleted = false;
  if (savePath && downloader.isSafeEpubPath(savePath, downloader.DOWNLOAD_PATH)) {
    try {
      const abs = path.resolve(savePath);
      if (fs.existsSync(abs)) { fs.unlinkSync(abs); fileDeleted = true; }
    } catch (err) {
      console.error('Library delete: file removal failed:', err.message);
    }
  }
  try { booktags.setTags(savePath, []); } catch { /* best effort */ }
  res.json({ ok: true, fileDeleted });
});

// Set the tags for a library book (identified by its download id).
app.put('/api/library/:id/tags', (req, res) => {
  const entry = history.readAll().find((e) => e.id === req.params.id && e.type === 'download' && e.savePath);
  if (!entry) return res.status(404).json({ error: 'Library book not found.' });
  const tags = booktags.setTags(entry.savePath, (req.body && req.body.tags) || []);
  res.json({ ok: true, tags });
});

// Update a library book's cover when it's wrong. Two modes:
//   - { cover: "https://…" }  → set that exact image, OR
//   - { refetch: true } / no cover → re-resolve from the catalog (FRESH, cache-
//     bypassed, by title+author). The new cover is written to EVERY download
//     entry for the same file so re-downloads stay consistent. Returns the cover.
app.put('/api/library/:id/cover', async (req, res) => {
  const target = history.readAll().find((e) => e.id === req.params.id && e.type === 'download' && e.savePath);
  if (!target) return res.status(404).json({ error: 'Library book not found.' });

  let cover = typeof (req.body && req.body.cover) === 'string' ? req.body.cover.trim() : '';
  if (cover) {
    if (!/^https:\/\//i.test(cover)) {
      return res.status(400).json({ error: 'Cover must be an https image URL.' });
    }
    if (cover.length > 2000) return res.status(400).json({ error: 'That URL is too long.' });
  } else {
    // Re-fetch from the catalog, bypassing the cache so a previously-wrong cover
    // can't be re-served. lookupCover hits the network directly.
    try {
      cover = (await covers.lookupCover({ title: target.title, author: target.author })) || '';
    } catch { cover = ''; }
    if (!cover) {
      return res.status(422).json({ error: 'Couldn’t find a cover automatically — paste an image URL instead.' });
    }
  }

  // Apply the cover against a FRESH read — the catalog lookup above is a network
  // round-trip, and a snapshot taken before it would be stale by now: writing it
  // back would erase anything the watcher/radar appended while we waited.
  const keyPath = path.resolve(target.savePath);
  history.mutate((entries) => {
    for (const e of entries) {
      if (e.type === 'download' && e.savePath && path.resolve(e.savePath) === keyPath) e.cover = cover;
    }
  });
  res.json({ ok: true, cover });
});

// --- Cover lookup: lazy per-book cover for Library rows lacking one ----------
// The client calls this only for rows scrolled into view (IntersectionObserver),
// so we never fan out lookups for the whole library at once. Results are cached
// to disk (src/covers.js) so a given book is looked up at most once. Fails soft:
// any miss/error returns { cover: null }.
app.get('/api/cover', async (req, res) => {
  const title = typeof req.query.title === 'string' ? req.query.title : '';
  const author = typeof req.query.author === 'string' ? req.query.author : '';
  if (!title.trim() && !author.trim()) return res.json({ cover: null });
  try {
    const cover = await covers.resolveCover({ title, author });
    res.json({ cover: cover || null });
  } catch {
    res.json({ cover: null });
  }
});

// --- Book metadata (cover + blurb) ------------------------------------------
// Like /api/cover, but also returns the catalog blurb. Used by the result card
// when a book was found inside a SET/collection: the forum post's title, cover
// and blurb describe the whole set, so we look up the actual searched book's own
// artwork + synopsis here (disk-cached via covers.resolveMeta). Fails soft.
app.get('/api/meta', async (req, res) => {
  const title = typeof req.query.title === 'string' ? req.query.title.slice(0, 300) : '';
  const author = typeof req.query.author === 'string' ? req.query.author.slice(0, 300) : '';
  if (!title.trim() && !author.trim()) return res.json({ cover: null, description: null });
  try {
    const meta = await covers.resolveMeta({ title, author });
    res.json({ cover: meta.cover || null, description: meta.description || null });
  } catch {
    res.json({ cover: null, description: null });
  }
});

// --- Notification recipients ------------------------------------------------
app.get('/api/recipients', (_req, res) => {
  res.json({ recipients: recipients.readAll() });
});

app.post('/api/recipients', (req, res) => {
  try {
    const entry = recipients.add(req.body || {});
    res.json({ recipient: entry });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/recipients/:id', (req, res) => {
  const removed = recipients.remove(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Recipient not found.' });
  res.json({ ok: true });
});

// --- Reader portal management (operator side, behind CF Access) --------------
// Invite emails the recipient their magic link (minting a token if needed and
// re-enabling their new-book emails).
app.post('/api/recipients/:id/invite', async (req, res) => {
  try {
    const r = await reader.invite(req.params.id);
    res.json({ ok: true, link: reader.readerLink(r) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Rotate the token: the old link dies instantly (leaked-link kill switch).
app.post('/api/recipients/:id/reader-token', (req, res) => {
  const r = reader.rotateToken(req.params.id);
  if (!r) return res.status(404).json({ error: 'Recipient not found.' });
  res.json({ ok: true, link: reader.readerLink(r) });
});

// Toggle whether they receive new-book emails (their link keeps working).
app.post('/api/recipients/:id/reader', (req, res) => {
  const r = reader.setReaderEnabled(req.params.id, !!(req.body || {}).enabled);
  if (!r) return res.status(404).json({ error: 'Recipient not found.' });
  res.json({ ok: true, readerEnabled: r.readerEnabled });
});

// --- Recipient groups (presets) ---------------------------------------------
app.get('/api/recipient-groups', (_req, res) => {
  res.json({ groups: recipients.readGroups() });
});

app.post('/api/recipient-groups', (req, res) => {
  try {
    const group = recipients.addGroup(req.body || {});
    res.json({ group });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/recipient-groups/:id', (req, res) => {
  const removed = recipients.removeGroup(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Group not found.' });
  res.json({ ok: true });
});

// --- Notification channel status (drives the Send UI) -----------------------
app.get('/api/notify/status', (_req, res) => {
  res.json({ channels: notify.listChannels(), kindle: kindle.isConfigured() });
});

// --- Send a test email (Settings panel: verify SMTP end-to-end) -------------
app.post('/api/notify/test', async (req, res) => {
  const email = typeof (req.body && req.body.email) === 'string' ? req.body.email.trim() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  try {
    await notify.sendTest(email);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Test send failed.' });
  }
});

// --- Operational status (drives the Status/health view) ---------------------
app.get('/api/status', async (_req, res) => {
  let session = { browser: false, ready: false, loggedIn: false, cfOk: false };
  try {
    session = await searcher.sessionStatus();
  } catch {
    /* leave defaults on a transient error */
  }
  const dir = downloader.DOWNLOAD_PATH;
  const downloads = health.readDownloadStats(dir);
  res.json({
    version: version.info(),
    session,
    download: { path: dir, ...downloads, disk: health.freeSpace(dir) },
    channels: notify.listChannels(),
    kindle: kindle.isConfigured(),
    premium: { hasCreds: downloader.hasPremiumCreds() },
    settings: {
      watchCheckIntervalMin: settings.getWatchIntervalMin(),
      watchMinMin: settings.MIN_WATCH_MIN,
      watchMaxMin: settings.MAX_WATCH_MIN,
      listsEnabled: settings.getListsEnabled(),
      listPullIntervalHours: settings.getListPullIntervalHours(),
    },
    lists: {
      configured: lists.isConfigured(),
      lastRunAt: lists.readState().lastRunAt,
      watching: watchlist.readAll().filter((w) => w.source === 'list' && w.status === 'active').length,
    },
  });
});

// Update user-tunable settings (watchlist cadence + new-release radar).
app.post('/api/settings', (req, res) => {
  const body = req.body || {};
  const out = {};
  if (body.watchCheckIntervalMin !== undefined) {
    out.watchCheckIntervalMin = settings.setWatchIntervalMin(body.watchCheckIntervalMin);
  }
  if (body.listsEnabled !== undefined) {
    out.listsEnabled = settings.setListsEnabled(body.listsEnabled);
  }
  if (body.listPullIntervalHours !== undefined) {
    out.listPullIntervalHours = settings.setListPullIntervalHours(body.listPullIntervalHours);
  }
  res.json({ ok: true, settings: { watchCheckIntervalMin: settings.getWatchIntervalMin(), ...out } });
});

// --- New-release list radar (issue #33) --------------------------------------
// Manual "Run now" for the radar: pulls the lists immediately regardless of
// cadence. The pull itself is only NYT API calls (no forum traffic), so it's
// safe to run on demand; acquisitions still drain politely via the watcher.
app.post('/api/lists/run', async (_req, res) => {
  try {
    const summary = await listwatcher.run({ force: true });
    res.json({ ok: true, ...summary });
  } catch (err) {
    console.error('List run failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Send: notify recipients (+ optional Kindle push) -----------------------
app.post('/api/send', async (req, res) => {
  const { downloadId, recipientIds, channels, book } = req.body || {};
  const pushToKindle = true; // always push to Kindle when recipient has a Kindle email
  if (!downloadId) return res.status(400).json({ error: 'Missing downloadId.' });
  if (!Array.isArray(recipientIds) || !recipientIds.length) {
    return res.status(400).json({ error: 'Pick at least one recipient.' });
  }

  // Resolve the file via history (never trust a client-supplied path) and make
  // sure it lives inside DOWNLOAD_PATH and is an .epub before attaching it.
  const entry = history.readAll().find((e) => e.id === downloadId && e.type === 'download');
  if (!entry || !entry.savePath) return res.status(404).json({ error: 'Download not found.' });
  if (!downloader.isSafeEpubPath(entry.savePath, downloader.DOWNLOAD_PATH)) {
    return res.status(400).json({ error: 'Refusing to send that file.' });
  }
  const filePath = path.resolve(entry.savePath);
  if (!fs.existsSync(filePath)) {
    return res.status(410).json({ error: 'File no longer exists on disk.' });
  }

  const recips = recipients.byIds(recipientIds);
  if (!recips.length) return res.status(404).json({ error: 'No matching recipients.' });

  // Build the book info for the email, preferring what the client passed, then
  // the stored download entry. A resend from the Library/batch carries only a
  // title, so author/cover/blurb are often missing here — derive the author from
  // the Mobilism "[Author]" filename so enrichment can disambiguate.
  const author = (book && book.author) || entry.author || library.authorFromFilename(entry.filename) || '';
  const bookInfo = {
    title: (book && book.title) || entry.title || '',
    author,
    cover: (book && book.cover) || entry.cover || null,
    description: (book && book.description) || '',
    filename: entry.filename,
  };
  // Fill any missing cover/blurb so the email always has artwork + a synopsis.
  // CRUCIAL: only when we know the author — a title-only lookup can grab the
  // wrong same-titled book (e.g. "Whistler"). With an author we use the SAME
  // author-aware lookup the Library shows, so the email matches it; with no
  // author we leave blanks rather than risk the wrong book. Fails soft.
  if (bookInfo.author && (!bookInfo.cover || !bookInfo.description)) {
    try {
      if (!bookInfo.cover) {
        bookInfo.cover = await covers.resolveCover({ title: bookInfo.title, author: bookInfo.author });
      }
      if (!bookInfo.description) {
        const meta = await covers.resolveMeta({ title: bookInfo.title, author: bookInfo.author });
        if (meta.description) bookInfo.description = meta.description;
      }
    } catch { /* leave blanks — never block a send on metadata */ }
  }
  const results = [];
  for (const r of recips) {
    const out = { id: r.id, name: r.name, kindle: null, channels: [] };

    if (pushToKindle && r.kindleEmail) {
      try {
        await kindle.pushToKindle({ kindleEmail: r.kindleEmail, filePath, filename: entry.filename });
        out.kindle = { ok: true };
      } catch (err) {
        out.kindle = { ok: false, error: err.message };
      }
    } else if (pushToKindle && !r.kindleEmail) {
      out.kindle = { ok: false, skipped: true, error: 'no Kindle email' };
    }

    out.channels = await notify.notify(r, { ...bookInfo, pushedToKindle: !!(out.kindle && out.kindle.ok) }, channels);

    history.logNotify({
      downloadId,
      title: bookInfo.title || entry.title,
      filename: entry.filename,
      to: [r.name],
      kindlePushed: !!(out.kindle && out.kindle.ok),
      channels: out.channels,
    });
    results.push(out);
  }

  res.json({ results });
});

// Ensure all unhandled Express errors return JSON rather than the default HTML
// error page (which causes the client to surface a confusing JSON-parse error).
// Must be defined after all routes; 4-arg signature is required by Express.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  if (!res.headersSent) res.status(500).json({ error: err.message || 'Internal server error' });
});

// Export the Express app so the routes can be integration-tested in-process
// (without binding a port or launching the browser). Only actually start the
// server, browser, schedulers, and VNC bridge when run directly.
module.exports = { app };

if (require.main === module) startServer();

function startServer() {
// Bind to loopback by default. In Docker the container is isolated by the
// host-side port mapping (127.0.0.1:3000:3000), so HOST=0.0.0.0 is safe there.
const HOST = process.env.HOST || '127.0.0.1';
const server = app.listen(PORT, HOST, () => {
  console.log(`BookHunt running at http://localhost:${PORT}`);
  console.log(`Downloads will be saved to: ${downloader.DOWNLOAD_PATH}`);
  // Launch the browser at startup and park it on the forum so /warm always shows
  // a usable page (ready to clear Cloudflare) and status reflects reality — even
  // before the first search.
  searcher
    .getSession()
    .then(({ page }) => page.goto(searcher.BASE_URL, { waitUntil: 'domcontentloaded' }))
    .then(() => console.log('Browser ready (headed under Xvfb) — warm at /warm if needed'))
    .catch((err) => console.error('Startup browser launch failed:', err.message))
    // Keep the session authenticated on its own — auto-clears Cloudflare + logs in
    // unattended, and only summons a human (via email) for interactive challenges.
    .finally(() => {
      autowarm.start();
      watcher.start(); // watchlist scheduler (issue #7)
      listwatcher.start(); // new-release list radar (issue #33)
    });
});

// noVNC's WebSocket doesn't pass through Express — bridge upgrades on /warm/* to
// websockify, stripping the /warm prefix so it lands on the VNC socket.
server.on('upgrade', async (req, socket, head) => {
  if (!req.url.startsWith('/warm/')) {
    socket.destroy();
    return;
  }
  // WebSocket upgrades bypass Express middleware, so re-check Cloudflare Access
  // here — otherwise the live in-container browser's VNC stream would be an
  // unauthenticated path around the front gate.
  if (!(await security.isUpgradeAuthorized(req))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  req.url = req.url.slice('/warm'.length); // '/warm/websockify' -> '/websockify'
  warmProxy.ws(req, socket, head);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use — is another instance running? ` +
        `(check with: ss -tlnp | grep ${PORT})`
    );
    process.exit(1);
  }
  throw err;
});

// Clean shutdown of the browser session.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await searcher.closeSession();
    process.exit(0);
  });
}
}
