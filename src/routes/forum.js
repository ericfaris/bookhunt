'use strict';

// Mobilism-facing operator routes: session status/login, search (single +
// batch, streamed), Amazon lookup, premium download, re-upload requests.

const express = require('express');
const { sendError } = require('./http');

const searcher = require('../searcher');
const downloader = require('../downloader');
const history = require('../history');
const amazon = require('../amazon');
const reupload = require('../reupload');
const reuploads = require('../reuploads');
const library = require('../library');
const covers = require('../covers');
const messages = require('../messages');
const batch = require('../batch');
const correct = require('../correct');
const sources = require('../sources');
const { openSSE } = require('../sse');
const { isForumUrl } = require('../security');

const router = express.Router();

// --- Session status (drives the re-warm banner) ----------------------------
router.get('/api/session/status', async (_req, res) => {
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
router.post('/api/session/login', async (_req, res) => {
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
router.post('/api/search', async (req, res) => {
  let { title, author, sort } = req.body || {};
  // Coerce + bound the free-text inputs so a hostile client can't push huge or
  // non-string values into the scraper/query builder.
  title = typeof title === 'string' ? title.slice(0, 300) : '';
  author = typeof author === 'string' ? author.slice(0, 300) : '';
  if (sort !== 'oldest') sort = 'newest'; // only two valid sorts
  if (!title && !author) {
    return res.status(400).json({ error: 'Enter a title and/or an author.' });
  }

  const stream = openSSE(res);
  const { send } = stream;
  // Cancellation (issue #28): cancel ONLY when the client truly disconnects.
  const signal = searcher.createCancelSignal();
  stream.onClientGone(() => signal.cancel());

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
      const hits = library.findInLibrary(await library.loadBooks(), { title, author }).slice(0, 3);
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
    stream.end();
  }
});

// --- Batch search -----------------------------------------------------------
// Searches a pasted list of books in one pass. Streamed as SSE for the same
// reason as /api/search (each entry is a full scrape; the whole batch is well
// past Cloudflare's 100s timeout). Searches run sequentially through the shared
// browser queue (searcher.search → enqueue), one entry never aborts the rest
// (batch.runSequential isolates failures), and the session is preflighted once
// so a stale session fails fast as a single 409 instead of per-entry stalls.
router.post('/api/search/batch', async (req, res) => {
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

  const stream = openSSE(res);
  const { send } = stream;

  // Cancellation (same posture as /api/search): a batch is a long sequence of
  // per-entry scrapes, so when the client truly disconnects mid-stream we must
  // stop — otherwise the batch "goes rogue" and keeps scraping after the page is
  // closed/refreshed. `batchCancelled` halts runSequential at the next entry
  // boundary; `currentSignal` aborts the entry currently in flight (its polite
  // delay + any live navigation). Guarded by writableEnded so our own res.end()
  // never trips it.
  let batchCancelled = false;
  let currentSignal = null;
  stream.onClientGone(() => {
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
    stream.end();
  }
});

// --- Amazon link → title/author -------------------------------------------
router.post('/api/amazon', async (req, res) => {
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
router.get('/api/premium/status', (_req, res) => {
  res.json({ hasCreds: downloader.hasPremiumCreds() });
});

router.post('/api/premium/creds', (req, res) => {
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

router.post('/api/download', async (req, res) => {
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

  // Heartbeat included: a mirror walk can go quiet past Cloudflare's 100s timeout.
  const stream = openSSE(res);
  const { send } = stream;
  // Cancellation (same posture as /api/search): only a real client disconnect.
  const signal = searcher.createCancelSignal();
  stream.onClientGone(() => signal.cancel());

  try {
    // downloader.premiumDownload/runCandidates don't accept a cancel signal
    // (they predate issue #28's cancellation work, and threading a signal
    // through the whole downloader is out of scope here) — so the minimal fix
    // is to check the signal at the one boundary runCandidates gives us:
    // between candidate posts, inside the attempt callback below. A cancelled
    // client stops the walk before the next candidate's scrape even starts.
    const { result, errors } = await downloader.runCandidates(
      posts,
      (cand) => {
        if (signal.cancelled) {
          const err = new Error('Download cancelled');
          err.cancelled = true;
          err.fatal = true; // stop the candidate walk immediately, don't try the next post
          throw err;
        }
        return downloader.premiumDownload(cand.url, send, searchedTitle || title);
      },
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
    // A cancellation isn't an error — the client already walked away, so
    // there's nothing (and nowhere) to report.
    if (!err || !err.cancelled) {
      console.error('Download failed:', err.detail || err); // full text kept server-side
      const info = messages.classifyError(err, { needWarm: !!err.needWarm });
      send({ step: 'error', ...info });
    }
  } finally {
    signal.settle();
    stream.end();
  }
});

// --- Standard download logging (links opened client-side) -------------------
router.post('/api/download/standard', (req, res) => {
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
router.post('/api/reupload', async (req, res) => {
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
    sendError(res, err, 'Re-upload request failed.');
  }
});

// --- Re-upload request management (issue #27) -------------------------------
// Mobilism's UCP page is authoritative; we annotate with local history so a row
// can deep-link back to the in-app book/thread. A stale session becomes a 409
// the UI turns into a re-warm prompt (same as /api/reupload).
router.get('/api/reupload/requests', async (_req, res) => {
  try {
    const data = await reuploads.listRequests();
    const reupHistory = history.readAll().filter((e) => e.type === 'reupload');
    res.json({ ...data, history: reupHistory });
  } catch (err) {
    console.error('Re-upload requests load failed:', err);
    sendError(res, err, 'Could not load re-upload requests.');
  }
});

router.post('/api/reupload/cancel', async (req, res) => {
  const { releaseNames } = req.body || {};
  if (!Array.isArray(releaseNames) || !releaseNames.length) {
    return res.status(400).json({ error: 'No requests selected to cancel.' });
  }
  try {
    const result = await reuploads.cancelRequests(releaseNames.map(String).slice(0, 50));
    res.json(result);
  } catch (err) {
    console.error('Re-upload cancel failed:', err);
    sendError(res, err, 'Could not cancel the request(s).');
  }
});

module.exports = router;
