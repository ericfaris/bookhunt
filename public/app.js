'use strict';

const $ = (sel) => document.querySelector(sel);

const searchForm = $('#searchForm');
const searchBtn = $('#searchBtn');
const statusEl = $('#status');
const resultsEl = $('#results');

// Pending download to resume after credentials are entered.
let pendingPremium = null;

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('#title').value.trim();
  const author = $('#author').value.trim();
  const sort = $('#sort').value;

  if (!title && !author) {
    showStatus('Enter a title and/or an author.', 'error');
    return;
  }

  runSearch({ title, author, sort });
});

// ---------------------------------------------------------------------------
// Amazon link → auto-fill title/author
// ---------------------------------------------------------------------------
const AMAZON_RE = /amazon\.|a\.co\b|amzn\./i;
const pasteBtn = $('#pasteAmazon');

pasteBtn.addEventListener('click', async () => {
  // Prefer the clipboard; fall back to a prompt if it's blocked or not a link.
  let link = '';
  try { link = ((await navigator.clipboard.readText()) || '').trim(); } catch { /* blocked */ }
  if (!AMAZON_RE.test(link)) {
    link = (window.prompt('Paste the Amazon book link:') || '').trim();
  }
  if (!link) return;
  if (!AMAZON_RE.test(link)) {
    showStatus("That doesn't look like an Amazon link.", 'error');
    return;
  }

  const original = pasteBtn.textContent;
  pasteBtn.disabled = true;
  pasteBtn.textContent = 'Reading…';
  showStatusHTML('<span class="spinner"></span>Reading the Amazon page…');
  try {
    const res = await fetch('/api/amazon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: link }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lookup failed');
    if (data.title) $('#title').value = data.title;
    if (data.author) $('#author').value = data.author;
    showStatus(`Filled from Amazon: “${data.title || '?'}” by ${data.author || '?'}`);
    setTimeout(hideStatus, 2500);
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    pasteBtn.disabled = false;
    pasteBtn.textContent = original;
  }
});

// ---------------------------------------------------------------------------
// Session warmth banner
// ---------------------------------------------------------------------------
const warmBanner = $('#warmBanner');

function showWarmBanner(show) {
  warmBanner.hidden = !show;
}

async function refreshSessionStatus() {
  try {
    const s = await fetch('/api/session/status').then((r) => r.json());
    // Only nag once the browser is actually up; on a cold boot it may be null.
    showWarmBanner(s.browser === true && !s.ready);
  } catch {
    /* leave the banner as-is on a transient error */
  }
}

// Poll periodically, on load, and whenever the tab regains focus (e.g. after
// the user finishes warming in the /warm tab and switches back).
refreshSessionStatus();
setInterval(refreshSessionStatus, 30000);
window.addEventListener('focus', refreshSessionStatus);

async function runSearch({ title, author, sort }) {
  resultsEl.innerHTML = '';
  searchBtn.disabled = true;
  showStatusHTML('<span class="spinner"></span>Searching Mobilism… this can take a minute (polite 2–5s delays between requests).');

  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, author, sort }),
    });
    const data = await res.json();
    if (res.status === 409 && data.needWarm) {
      showWarmBanner(true);
      showStatus('Mobilism session expired — click “Re-warm ↗” above, then search again.', 'error');
      return;
    }
    if (!res.ok) throw new Error(data.error || 'Search failed');

    if (!data.results.length) {
      renderNotFound(data.fallbackLinks);
    } else {
      hideStatus();
      data.results.forEach(renderCard);
    }
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    searchBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

function renderCard(r) {
  const cover = r.cover
    ? el('img', { className: 'cover', src: r.cover, alt: 'cover', loading: 'lazy' })
    : el('div', { className: 'cover placeholder' }, 'No cover');

  const badges = el('div', { className: 'badges' }, [
    el('span', { className: 'badge' }, r.format || 'ePUB'),
    el('span', { className: 'badge src' }, r.source),
    r.premium ? el('span', { className: 'badge prem' }, 'Premium') : null,
  ]);

  const metaBits = [];
  if (r.size) metaBits.push(el('span', {}, `📦 ${r.size}`));
  if (r.date) metaBits.push(el('span', {}, `📅 ${formatDate(r.date)}`));
  if (r.category) metaBits.push(el('span', {}, `🗂 ${r.category}`));
  const meta = el('div', { className: 'meta' }, metaBits);

  const dlRow = el('div', { className: 'dl-row' });
  if (r.premium) {
    const btn = el('button', { className: 'dl-btn premium', type: 'button' }, 'Download (Premium)');
    btn.addEventListener('click', () => premiumDownload(r, btn, dlRow));
    dlRow.append(btn);
  } else if (r.postlinks && r.postlinks.length) {
    for (const link of r.postlinks) {
      const btn = el('button', { className: 'dl-btn', type: 'button' }, link.host);
      btn.addEventListener('click', () => {
        window.open(link.url, '_blank', 'noopener');
        logStandard(link, r.title);
      });
      dlRow.append(btn);
    }
  } else {
    dlRow.append(el('span', { className: 'hint' }, 'No download links found'));
  }
  dlRow.append(el('a', { className: 'topic-link', href: r.url, target: '_blank', rel: 'noopener' }, 'View thread ↗'));

  const body = el('div', { className: 'card-body' }, [
    el('h3', {}, r.title),
    r.author ? el('p', { className: 'author' }, r.author) : null,
    badges,
    meta,
    dlRow,
  ]);

  resultsEl.append(el('div', { className: 'card' }, [cover, body]));
}

function renderNotFound(links) {
  const linkBits = [];
  if (links?.title) linkBits.push(el('a', { href: links.title, target: '_blank', rel: 'noopener' }, 'Open title search on Mobilism ↗'));
  if (links?.author) linkBits.push(el('a', { href: links.author, target: '_blank', rel: 'noopener' }, 'Open author search on Mobilism ↗'));
  statusEl.hidden = false;
  statusEl.className = 'status';
  statusEl.innerHTML = '<strong>Not found.</strong> No ePUB matches turned up. Try the manual searches:';
  statusEl.append(el('div', { className: 'links' }, linkBits));
}

function formatDate(d) {
  const parsed = new Date(d);
  return isNaN(parsed) ? d : parsed.toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------
async function premiumDownload(result, btn, dlRow) {
  // Make sure credentials exist first.
  const status = await fetch('/api/premium/status').then((r) => r.json());
  if (!status.hasCreds) {
    pendingPremium = { result, btn, dlRow };
    openCredModal();
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Downloading…';
  clearDlResult(dlRow);

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: result.url, title: result.title }),
    });
    const data = await res.json();
    if (res.status === 401 && data.needCreds) {
      pendingPremium = { result, btn, dlRow };
      btn.disabled = false;
      btn.textContent = 'Download (Premium)';
      openCredModal();
      return;
    }
    if (!res.ok) throw new Error(data.error || 'Download failed');

    for (const d of data.downloads) {
      dlRow.parentElement.append(
        el('div', { className: 'dl-result' }, `✓ ${d.filename} → ${d.savePath}  (${formatTime(d.timestamp)})`)
      );
    }
    for (const e of data.errors || []) {
      dlRow.parentElement.append(el('div', { className: 'dl-result err' }, `✕ ${e.error}`));
    }
    if (!data.downloads.length && !(data.errors || []).length) {
      dlRow.parentElement.append(el('div', { className: 'dl-result err' }, 'Nothing was downloaded.'));
    }
  } catch (err) {
    dlRow.parentElement.append(el('div', { className: 'dl-result err' }, `✕ ${err.message}`));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Download (Premium)';
  }
}

function clearDlResult(dlRow) {
  dlRow.parentElement.querySelectorAll('.dl-result').forEach((n) => n.remove());
}

function formatTime(t) {
  const d = new Date(t);
  return isNaN(d) ? t : d.toLocaleTimeString();
}

function logStandard(link, title) {
  fetch('/api/download/standard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: link.url, host: link.host, title }),
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Credentials modal
// ---------------------------------------------------------------------------
const credModal = $('#credModal');
$('#credCancel').addEventListener('click', closeCredModal);
$('#credForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const user = $('#premUser').value.trim();
  const pass = $('#premPass').value;
  const res = await fetch('/api/premium/creds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, pass }),
  });
  if (!res.ok) return;
  closeCredModal();
  $('#premPass').value = '';
  if (pendingPremium) {
    const { result, btn, dlRow } = pendingPremium;
    pendingPremium = null;
    premiumDownload(result, btn, dlRow);
  }
});

function openCredModal() { credModal.hidden = false; $('#premUser').focus(); }
function closeCredModal() { credModal.hidden = true; }

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
const historyPanel = $('#historyPanel');
const overlay = $('#overlay');
$('#historyToggle').addEventListener('click', openHistory);
$('#historyClose').addEventListener('click', closeHistory);
overlay.addEventListener('click', closeHistory);

async function openHistory() {
  const data = await fetch('/api/history').then((r) => r.json());
  const list = $('#historyList');
  list.innerHTML = '';
  if (!data.entries.length) {
    list.append(el('p', { className: 'hint' }, 'No history yet.'));
  }
  for (const entry of data.entries) {
    list.append(renderHistoryItem(entry));
  }
  historyPanel.hidden = false;
  overlay.hidden = false;
}

function closeHistory() {
  historyPanel.hidden = true;
  overlay.hidden = true;
}

function renderHistoryItem(entry) {
  const when = el('div', { className: 'when' }, new Date(entry.timestamp).toLocaleString());
  const item = el('div', { className: 'history-item' });

  if (entry.type === 'search') {
    const label = [entry.title && `“${entry.title}”`, entry.author && `by ${entry.author}`]
      .filter(Boolean)
      .join(' ');
    item.append(el('div', {}, `🔍 ${label || '(empty)'} — ${entry.resultCount} result(s)`));
    const rerun = el('button', { className: 'ghost-btn rerun', type: 'button' }, 'Re-run');
    rerun.addEventListener('click', () => {
      $('#title').value = entry.title || '';
      $('#author').value = entry.author || '';
      $('#sort').value = entry.sort || 'newest';
      closeHistory();
      runSearch({ title: entry.title || '', author: entry.author || '', sort: entry.sort || 'newest' });
    });
    item.append(rerun);
  } else {
    const where = entry.savePath ? ` → ${entry.savePath}` : '';
    item.append(el('div', {}, `⬇ ${entry.filename || 'download'}${where}`));
    if (entry.title) item.append(el('div', { className: 'hint' }, entry.title));
  }
  item.append(when);
  return item;
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------
// Plain-text status — used for everything that can echo server/site content
// (error messages especially), so nothing gets interpreted as HTML.
function showStatus(text, kind) {
  statusEl.hidden = false;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
  statusEl.textContent = text;
}
// HTML status — only ever called with trusted, hardcoded markup (spinner).
function showStatusHTML(html) {
  statusEl.hidden = false;
  statusEl.className = 'status';
  statusEl.innerHTML = html;
}
function hideStatus() { statusEl.hidden = true; }
