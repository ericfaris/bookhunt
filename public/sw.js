'use strict';

// BookHunt service worker (issue #18). Caches ONLY the static app shell so the
// app installs and launches standalone / offline-tolerant. It deliberately
// never caches API responses or the live-browser proxy (/warm) — those must
// always hit the network so auth / Cloudflare Access and fresh data behave
// exactly as without a SW.
//
// Strategy: NETWORK-FIRST for the shell. A cache-first shell (the old behaviour)
// pinned index.html/app.js/style.css to whatever was first cached, so a normal
// refresh kept serving the OLD app after a deploy — new UI (e.g. the watchlist
// button) only appeared after a hard reload (CTRL+F5) that bypasses the SW. With
// network-first, an online refresh always gets the freshly deployed assets and
// the cache updates behind it; the cache is only used as an OFFLINE fallback.
// Bump CACHE on changes that must evict the previous shell.

const CACHE = 'bookhunt-shell-v3'; // bumped: evict anything /reader/api cached before issue #38's fix
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/favicon.svg',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Leave cross-origin (book covers, external sources) to the browser.
  if (url.origin !== self.location.origin) return;
  // Never intercept API or the live-browser proxy — always go to the network.
  // `/reader/api` doesn't start with `/api` (issue #38: it was slipping past
  // this guard and getting cached below despite the server marking those
  // responses `Cache-Control: no-store` — personal shelf data, token in the
  // URL). Match it explicitly rather than only the general `/api` prefix.
  if (
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/reader/api') ||
    url.pathname.startsWith('/warm')
  ) {
    return;
  }

  // Network-first: serve the freshest shell when online, update the cache, and
  // fall back to the cache (or the cached index.html for navigations) offline.
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        // Belt-and-braces on top of the path check above: never cache a
        // response the server explicitly marked no-store, whichever path it
        // came from — so a future personal/no-store route can't be silently
        // cached just because someone forgot to extend the prefix list here.
        const noStore = /no-store/i.test(res && res.headers.get('Cache-Control') || '');
        if (res && res.ok && res.type === 'basic' && !noStore) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      } catch (err) {
        const cached = await caches.match(req);
        if (cached) return cached;
        if (req.mode === 'navigate') {
          const shell = await caches.match('/index.html');
          if (shell) return shell;
        }
        throw err;
      }
    })()
  );
});
