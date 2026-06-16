'use strict';

// BookHunt service worker (issue #18). Caches ONLY the static app shell so the
// app installs and launches standalone / offline-tolerant. It deliberately
// never caches API responses or the live-browser proxy (/warm) — those must
// always hit the network so auth / Cloudflare Access and fresh data behave
// exactly as without a SW.

const CACHE = 'bookhunt-shell-v1';
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
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/warm')) return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        // Opportunistically cache same-origin static GETs that succeed.
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      } catch (err) {
        // Offline: fall back to the cached shell for navigations.
        if (req.mode === 'navigate') {
          const shell = await caches.match('/index.html');
          if (shell) return shell;
        }
        throw err;
      }
    })()
  );
});
