'use strict';

const fs = require('fs');
const path = require('path');

// Cloudflare's Browser Cache TTL rewrites our static JS/CSS to `max-age=14400`
// whatever Cache-Control we send (HTML passes through untouched as DYNAMIC).
// So after a deploy, browsers ran the OLD script against the NEW page for
// hours — on the reader shelf the tap-a-book modal did nothing. Fix: pages are
// served through stampAssets(), which appends `?v=<content hash>` to their
// script/stylesheet URLs. A changed file is a new URL that no browser, edge,
// or service-worker cache has seen; an unchanged one keeps its cached copy.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// Memoized per file on its mtime: the files never change inside a container,
// but a dev edit under `npm run dev` still gets a fresh hash.
const _fileMemo = new Map();
function memoFile(file, derive) {
  const abs = path.join(PUBLIC_DIR, file);
  const mtime = fs.statSync(abs).mtimeMs;
  const hit = _fileMemo.get(abs);
  if (hit && hit.mtime === mtime) return hit.value;
  const value = derive(fs.readFileSync(abs));
  _fileMemo.set(abs, { mtime, value });
  return value;
}
function assetHash(file) {
  return memoFile(file, (buf) => require('crypto').createHash('sha256').update(buf).digest('hex').slice(0, 12));
}
/** Read public/<page> and version each `attr="url"` → hash of public/<file>. */
function stampAssets(page, assets) {
  let html = memoFile(page, (buf) => buf.toString('utf8'));
  for (const { attr, url, file } of assets) {
    html = html.replace(`${attr}="${url}"`, `${attr}="${url}?v=${assetHash(file)}"`);
  }
  return html;
}
const readerPageHtml = () => stampAssets('reader.html', [{ attr: 'src', url: '/reader/app.js', file: 'reader.js' }]);
const appPageHtml = () => stampAssets('index.html', [
  { attr: 'src', url: 'app.js', file: 'app.js' },
  { attr: 'href', url: 'style.css', file: 'style.css' },
]);

module.exports = { PUBLIC_DIR, stampAssets, readerPageHtml, appPageHtml };
