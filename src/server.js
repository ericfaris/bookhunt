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

const PORT = process.env.PORT || 3000;
const app = express();

app.use(express.json());

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

app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Session status (drives the re-warm banner) ----------------------------
app.get('/api/session/status', async (_req, res) => {
  try {
    res.json(await searcher.sessionStatus());
  } catch (err) {
    res.status(500).json({ error: err.message, ready: false });
  }
});

// --- Search -----------------------------------------------------------------
app.post('/api/search', async (req, res) => {
  const { title, author, sort } = req.body || {};
  if (!title && !author) {
    return res.status(400).json({ error: 'Enter a title and/or an author.' });
  }
  try {
    const { results, fallbackLinks } = await searcher.search({ title, author, sort });
    history.logSearch({ title, author, sort, resultCount: results.length });
    res.json({ results, fallbackLinks });
  } catch (err) {
    console.error('Search failed:', err);
    if (err.needWarm) {
      return res.status(409).json({ error: err.message, needWarm: true });
    }
    res.status(500).json({ error: err.message });
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
app.post('/api/download', async (req, res) => {
  const { url, title } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing post url.' });
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
    const result = await downloader.premiumDownload(url, send);
    for (const d of result.downloads) {
      const stored = history.logDownload({
        title: title || result.title,
        filename: d.filename,
        savePath: d.savePath,
        url: d.url,
        mode: 'premium',
        verified: d.verified,
        size: d.size,
      });
      d.id = stored.id; // safe handle the client passes back to /api/send
    }
    send({ step: 'done', downloads: result.downloads, errors: result.errors, title: result.title });
  } catch (err) {
    console.error('Download failed:', err.detail || err); // full text kept server-side
    send({ step: 'error', error: err.message, needWarm: !!err.needWarm });
  } finally {
    res.end();
  }
});

// --- Standard download logging (links opened client-side) -------------------
app.post('/api/download/standard', (req, res) => {
  const { url, host, title } = req.body || {};
  history.logDownload({ title, filename: host || 'external link', savePath: null, url, mode: 'standard' });
  res.json({ ok: true });
});

// --- History ----------------------------------------------------------------
app.get('/api/history', (_req, res) => {
  res.json({ entries: history.readAll() });
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

// --- Notification channel status (drives the Send UI) -----------------------
app.get('/api/notify/status', (_req, res) => {
  res.json({ channels: notify.listChannels(), kindle: kindle.isConfigured() });
});

// --- Send: notify recipients (+ optional Kindle push) -----------------------
app.post('/api/send', async (req, res) => {
  const { downloadId, recipientIds, pushToKindle, channels, book } = req.body || {};
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

  const bookInfo = { ...(book || {}), filename: entry.filename };
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

// Bind to loopback by default. In Docker the container is isolated by the
// host-side port mapping (127.0.0.1:3000:3000), so HOST=0.0.0.0 is safe there.
const HOST = process.env.HOST || '127.0.0.1';
const server = app.listen(PORT, HOST, () => {
  console.log(`Mobilism Ebook Finder running at http://localhost:${PORT}`);
  console.log(`Downloads will be saved to: ${downloader.DOWNLOAD_PATH}`);
  // Launch the browser at startup and park it on the forum so /warm always shows
  // a usable page (ready to clear Cloudflare) and status reflects reality — even
  // before the first search.
  searcher
    .getSession()
    .then(({ page }) => page.goto(searcher.BASE_URL, { waitUntil: 'domcontentloaded' }))
    .then(() => console.log('Browser ready (headed under Xvfb) — warm at /warm if needed'))
    .catch((err) => console.error('Startup browser launch failed:', err.message));
});

// noVNC's WebSocket doesn't pass through Express — bridge upgrades on /warm/* to
// websockify, stripping the /warm prefix so it lands on the VNC socket.
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/warm/')) {
    req.url = req.url.slice('/warm'.length); // '/warm/websockify' -> '/websockify'
    warmProxy.ws(req, socket, head);
  } else {
    socket.destroy();
  }
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
