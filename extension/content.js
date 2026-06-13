'use strict';

// Mooseflip Amazon helper — content script.
// Scrapes the book's title/author from the product page (mirroring the cleaning
// in the app's server-side src/amazon.js so results match the Paste button) and
// opens the Mooseflip search prefilled. Adds a visible button near the title's
// share icon, with a fixed-position floating fallback, and answers the
// background worker's requests for the right-click / toolbar entries.

const APP_URL = 'https://read.mooseflip.com/';

// --- scraping (mirror of src/amazon.js cleanTitle/cleanAuthor) -------------
const collapse = (s) => (s || '').replace(/\s+/g, ' ').trim();

function cleanTitle(t) {
  if (!t) return '';
  let s = t.split(/\s[:–—]\s|:\s/)[0];
  s = s.replace(
    /\s*[([][^)\]]*\b(edition|kindle|paperback|hardcover|audiobook|audio)\b[^)\]]*[)\]]\s*$/i,
    ''
  );
  return s.trim();
}

function cleanAuthor(a) {
  if (!a) return '';
  return a.replace(/\([^)]*\)/g, '').replace(/[,;]+\s*$/, '').trim();
}

function scrape() {
  const titleEl = document.querySelector('#productTitle');
  const title = cleanTitle(collapse(titleEl ? titleEl.textContent : ''));

  let author = '';
  const byline = document.querySelector('#bylineInfo');
  if (byline) {
    // Prefer the contributor link whose role label is "(Author)".
    for (const sp of byline.querySelectorAll('.author')) {
      const a = sp.querySelector('a');
      if (a && /author/i.test(sp.textContent)) {
        author = collapse(a.textContent);
        break;
      }
    }
    if (!author) {
      const a = byline.querySelector('a');
      if (a) author = collapse(a.textContent);
    }
  }
  return { title, author: cleanAuthor(author) };
}

function buildUrl({ title, author }) {
  const u = new URL(APP_URL);
  if (title) u.searchParams.set('title', title);
  if (author) u.searchParams.set('author', author);
  // Fallback the app can use if the DOM scrape came back empty.
  u.searchParams.set('amazon', location.href);
  return u.href;
}

function openSearch() {
  const data = scrape();
  if (!data.title && !data.author) {
    // Not a recognizable product page — hand off the URL and let the server scrape.
    window.open(`${APP_URL}?amazon=${encodeURIComponent(location.href)}`, '_blank', 'noopener');
    return;
  }
  window.open(buildUrl(data), '_blank', 'noopener');
}

// --- injected button -------------------------------------------------------
function makeButton() {
  const btn = document.createElement('button');
  btn.id = 'mooseflip-search-btn';
  btn.type = 'button';
  btn.textContent = '🔍 Search on Mooseflip';
  Object.assign(btn.style, {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    margin: '8px 0',
    padding: '6px 12px',
    fontSize: '13px',
    fontWeight: '600',
    color: '#fff',
    background: '#2563eb',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    boxShadow: '0 1px 2px rgba(0,0,0,.15)',
  });
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    openSearch();
  });
  return btn;
}

function injectButton() {
  if (document.getElementById('mooseflip-search-btn')) return true;
  // Only on book product pages.
  if (!document.querySelector('#productTitle')) return false;

  const btn = makeButton();
  // Anchor near the title / share area; fall back to a fixed floating button.
  const anchor =
    document.querySelector('#titleSection') ||
    document.querySelector('#title')?.parentElement ||
    document.querySelector('#productTitle')?.closest('div');
  if (anchor) {
    anchor.appendChild(btn);
  } else {
    Object.assign(btn.style, {
      position: 'fixed',
      right: '20px',
      bottom: '20px',
      zIndex: '2147483647',
      margin: '0',
      padding: '10px 14px',
    });
    document.body.appendChild(btn);
  }
  return true;
}

// Amazon hydrates the title block late and swaps it on navigation; retry via a
// MutationObserver until the button lands, then keep it alive across SPA swaps.
if (!injectButton()) {
  const obs = new MutationObserver(() => injectButton());
  obs.observe(document.documentElement, { childList: true, subtree: true });
}

// --- background worker requests (context menu / toolbar action) ------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'mooseflip:open') {
    openSearch();
    sendResponse({ ok: true });
  }
  return true;
});
