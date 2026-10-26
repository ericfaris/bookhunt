'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const httpProxy = require('http-proxy');

const searcher = require('./searcher');
const downloader = require('./downloader');
const security = require('./security');
const autowarm = require('./autowarm');
const watcher = require('./watcher');
const listwatcher = require('./listwatcher');
const datastore = require('./datastore');
const storage = require('./storage');
const { appPageHtml } = require('./assets');

const PORT = process.env.PORT || 3000;
const app = express();

// --- Container healthcheck (issue #39) --------------------------------------
// Docker's `restart: unless-stopped` only restarts on PROCESS EXIT — it can't
// see the app's actual failure mode, which is Node staying alive while the
// browser session underneath it is wedged. This is a bare process-liveness
// probe ONLY: it does not check searcher.sessionStatus(). A cold/unauthenticated
// Mobilism session is a normal, expected state that autowarm + /warm exist to
// resolve on their own — restarting the container on it would fight autowarm
// and could throw away a half-cleared Cloudflare challenge. Mounted before
// EVERY other middleware (Access verification, rate limiting) so it's always
// reachable for Docker's in-container probe regardless of Access config, and
// deliberately unauthenticated — it leaks nothing beyond "the process is up".
//
// R2 storage (#47) only ADDS an informational `storage` block in r2 mode — the
// status stays 200 regardless, since a restart can't fix a remote R2 outage
// (same reasoning as the Mobilism session above). Local mode: exactly { ok: true }.
app.get('/healthz', (_req, res) => {
  let body = { ok: true };
  try {
    const s = storage.get();
    if (s.mode !== 'local') {
      const h = s.healthInfo();
      body = { ok: true, storage: { mode: h.mode, ok: h.ok, indexLoaded: h.indexLoaded, lastRefreshAt: h.lastRefreshAt } };
    }
  } catch { /* stay { ok: true } */ }
  res.status(200).json(body);
});

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

// Per-IP rate limit on the API. Bumped 120 → 300/min: even after fixing the
// watchlist's uncached-cover-fetch-per-render bug, normal browsing (library
// covers/blurbs via IntersectionObserver, /api/meta lookups, 30s session-status
// polling) plus a handful of watchlist actions was still enough to trip 120 —
// see the "Remove failed / Watch again failed (HTTP 429)" reports. Still well
// below anything a real hammering/abuse burst would look like.
app.use('/api', security.rateLimiter({ windowMs: 60_000, max: 300 }));

// --- Reader portal (issue #34) ----------------------------------------------
// See src/routes/reader.js.
app.use(require('./routes/reader'));

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

// The operator app shell, with versioned app.js/style.css (see stampAssets).
// Registered before express.static so it wins for `/` and `/index.html`.
app.get(['/', '/index.html'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(appPageHtml());
});

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

// --- Operator API -----------------------------------------------------------
app.use(require('./routes/forum'));
app.use(require('./routes/watchlist'));
app.use(require('./routes/library'));
app.use(require('./routes/recipients'));
app.use(require('./routes/ops'));

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

if (require.main === module) {
  startServer().catch((err) => {
    console.error('Startup failed:', err.message);
    process.exit(1);
  });
}

async function startServer() {
// Storage first (#47): validate config and fail fast — before the browser
// launches or the port binds — so STORAGE=r2 with missing R2_* vars exits
// with a clear message instead of half-starting. In r2 mode, warm the key
// index before listening so the first Library render is right, but bounded:
// an R2 outage must never keep the app (and /warm) down. Never logs
// credentials, the account id or the endpoint.
let store;
try {
  store = storage.init(process.env);
} catch (err) {
  console.error(`[storage] ${err.message}`);
  process.exit(1);
}
if (store.mode === 'r2') {
  storage.sweepStaging(store.stagingDir(), 60 * 60 * 1000);
  const timeoutMs = Number(process.env.STORAGE_STARTUP_TIMEOUT_MS) || 15000;
  try {
    await Promise.race([
      store.refresh(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs).unref()),
    ]);
    console.log(`Storage: R2 bucket "${store.bucket}" — ${store.healthInfo().objectCount} object(s) indexed`);
  } catch (err) {
    console.error(
      `Storage: R2 bucket "${store.bucket}" UNREACHABLE at startup (${err.message}) — ` +
        'library will show books as missing until it recovers; retrying in background'
    );
  }
  storage.startRefreshTimer(Number(process.env.STORAGE_INDEX_REFRESH_MS) || 600000);
}

// Durable JSON stores (history, watchlist, recipients, …): with DATA_STORE=mongo
// reconcile every store with its Atlas copy BEFORE anything reads them (a
// rebuilt machine restores here). Bounded by the driver's server-selection
// timeout; an outage runs on the local files unless one is missing, in which
// case init refuses to start rather than overwrite Atlas with empty data.
try {
  const out = await datastore.init(process.env);
  const st = datastore.status();
  if (st.mode === 'mongo' && out) console.log(`Data: Atlas mirror on — ${JSON.stringify(out)}`);
  else if (st.mode === 'file') console.log('Data: local JSON files only (DATA_STORE=file) — no offsite copy');
} catch (err) {
  console.error(`[datastore] ${err.message}`);
  process.exit(1);
}

// Bind to loopback by default. In Docker the container is isolated by the
// host-side port mapping (127.0.0.1:3000:3000), so HOST=0.0.0.0 is safe there.
const HOST = process.env.HOST || '127.0.0.1';
const server = app.listen(PORT, HOST, () => {
  console.log(`BookHunt running at http://localhost:${PORT}`);
  if (store.mode === 'local') {
    console.log(`Downloads will be saved to: ${downloader.DOWNLOAD_PATH}`);
  } else {
    console.log(`Downloads will be staged in ${store.stagingDir()} and stored in ${store.displayPath()}`);
  }
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

// Clean shutdown: let queued Atlas writes land (bounded), then close the browser.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await datastore.flush(5000).catch(() => {});
    await searcher.closeSession();
    process.exit(0);
  });
}
}
