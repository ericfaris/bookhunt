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

    // A failure before the stream opens (e.g. the empty-query 400) still comes
    // back as a normal JSON body, not SSE.
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Search failed');
    }
    if (!res.body) {
      throw new Error('Server returned an unexpected response — check the session or try re-warming.');
    }

    // Read the Server-Sent-Events stream (`data: {…}\n\n`, with `: ping`
    // heartbeats). Progress frames update the spinner; a terminal done/error
    // frame carries the payload. The long scrape is what keeps Cloudflare from
    // 524-ing — the stream never sits silent for 100s.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue; // heartbeat / comment frame
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }

        if (ev.step === 'progress') {
          showSearchProgress(ev);
        } else if (ev.step === 'error') {
          finished = true;
          if (ev.needWarm) {
            showWarmBanner(true);
            showStatus('Mobilism session expired — click “Re-warm ↗” above, then search again.', 'error');
          } else {
            showStatus(ev.error || 'Search failed', 'error');
          }
        } else if (ev.step === 'done') {
          finished = true;
          if (!ev.results.length) {
            renderNotFound(ev.fallbackLinks);
          } else {
            hideStatus();
            ev.results.forEach(renderCard);
          }
        }
      }
    }
    if (!finished) {
      throw new Error('Search ended unexpectedly — try re-warming the session.');
    }
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    searchBtn.disabled = false;
  }
}

// Map a backend search phase to friendly spinner text.
function showSearchProgress(ev) {
  const msgs = {
    'title-search': 'Searching Mobilism titles…',
    'scanning': `Scanning results…${ev.found ? ` (${ev.found} found so far)` : ''}`,
    'collections': 'Checking collection posts…',
    'author-collections': 'Looking for “books by author” sets…',
    'author-fallback': 'Broadening to an author search…',
  };
  const text = msgs[ev.phase] || 'Searching Mobilism…';
  showStatusHTML(`<span class="spinner"></span>${text} <span class="hint">(polite delays — this can take a minute)</span>`);
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
    btn.addEventListener('click', () => premiumDownload(r, btn));
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
// The ordered checklist shown in the download modal. Each backend progress
// event advances one of these steps (pending → active → done / fail).
const DL_STEPS = [
  { id: 'read', label: 'Read the Mobilism post' },
  { id: 'login', label: 'Sign in to the premium downloader' },
  { id: 'fetch', label: 'Download from a mirror' },
  { id: 'verify', label: "Open the ePUB & confirm it's the right book" },
];

async function premiumDownload(result, btn) {
  // Make sure credentials exist first.
  const status = await fetch('/api/premium/status').then((r) => r.json());
  if (!status.hasCreds) {
    pendingPremium = { result, btn };
    openCredModal();
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Downloading…'; }
  openDownloadModal(result);

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: result.url, title: result.title, searchedTitle: $('#title').value.trim() }),
    });
    if (res.status === 401) {
      const data = await res.json().catch(() => ({}));
      if (data.needCreds) {
        closeDownloadModal();
        pendingPremium = { result, btn };
        openCredModal();
        return;
      }
    }
    if (!res.ok || !res.body) throw new Error('Download request failed (HTTP ' + res.status + ')');

    // Read the Server-Sent-Events stream framed as `data: {…}\n\n`.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        try {
          handleDownloadEvent(JSON.parse(line.slice(5).trim()), result);
        } catch { /* ignore a malformed frame */ }
      }
    }
  } catch (err) {
    renderDownloadError(err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Download (Premium)'; }
    $('#dlClose').hidden = false;
  }
}

// --- Download modal -------------------------------------------------------
const downloadModal = $('#downloadModal');
$('#dlClose').addEventListener('click', closeDownloadModal);

function openDownloadModal(result) {
  $('#dlHeading').textContent = 'Downloading…';
  $('#dlHeading').className = '';
  $('#dlBook').textContent = `${result.title || ''}${result.author ? ' — ' + result.author : ''}`;
  $('#dlResult').innerHTML = '';
  $('#dlClose').hidden = true;
  const list = $('#dlSteps');
  list.innerHTML = '';
  for (const s of DL_STEPS) {
    list.append(
      el('li', { className: 'dl-step pending', id: 'dlstep-' + s.id }, [
        el('span', { className: 'dl-step-icon' }, '○'),
        el('span', { className: 'dl-step-label' }, s.label),
        el('span', { className: 'dl-step-note' }, ''),
      ])
    );
  }
  downloadModal.hidden = false;
}
function closeDownloadModal() { downloadModal.hidden = true; }

function setStep(id, state, note) {
  const li = $('#dlstep-' + id);
  if (!li) return;
  li.className = 'dl-step ' + state;
  const icon = { pending: '○', active: '◌', done: '✓', fail: '✕', warn: '⚠' }[state] || '○';
  li.querySelector('.dl-step-icon').textContent = icon;
  if (note != null) li.querySelector('.dl-step-note').textContent = note;
}

function handleDownloadEvent(ev, result) {
  switch (ev.step) {
    case 'reading-post':
      setStep('read', 'active');
      break;
    case 'mirrors-found':
      setStep('read', 'done', `Found ${ev.total} mirror${ev.total === 1 ? '' : 's'}`);
      break;
    case 'mirror':
      // A new mirror attempt begins — reset the per-mirror steps.
      setStep('login', 'pending', '');
      setStep('fetch', 'active', `Mirror ${ev.index} of ${ev.total}${ev.host ? ' · ' + ev.host : ''}`);
      setStep('verify', 'pending', '');
      break;
    case 'login':
      setStep('login', 'active');
      break;
    case 'downloading':
      setStep('login', 'done');
      setStep('fetch', 'active', ev.host ? `Downloading from ${ev.host}…` : 'Downloading…');
      break;
    case 'saved':
      setStep('fetch', 'done', ev.filename || '');
      break;
    case 'verifying':
      setStep('verify', 'active', 'Opening the ePUB…');
      break;
    case 'verified':
      if (!ev.verified) setStep('verify', 'fail', 'Failed the ePUB structure check');
      else if (ev.titleMatch === false) setStep('verify', 'warn', `Embedded title: “${ev.embeddedTitle}”`);
      else if (ev.titleMatch === true) setStep('verify', 'done', `Title “${ev.embeddedTitle}” matches ✓`);
      else setStep('verify', 'done', 'Valid ePUB (no embedded title to compare)');
      break;
    case 'mirror-failed':
      setStep('fetch', 'fail', `${ev.host || 'mirror'}: ${ev.error}`);
      break;
    case 'done':
      renderDownloadDone(ev, result);
      break;
    case 'error':
      renderDownloadError(ev.error, ev.needWarm);
      break;
  }
}

function renderDownloadDone(data, result) {
  const box = $('#dlResult');
  box.innerHTML = '';
  const d = (data.downloads || [])[0];

  if (d && d.verified) {
    const allGood = d.titleMatch !== false; // null or true → celebrate
    $('#dlHeading').textContent = allGood ? '🎉 Downloaded & verified!' : 'Downloaded — please double-check';
    $('#dlHeading').className = allGood ? 'dl-success' : 'dl-warn-head';
    if (allGood) celebrate();

    const lines = [
      el('div', { className: 'dl-line' }, [el('strong', {}, '📗 '), d.filename]),
      el('div', { className: 'dl-line hint' }, `Saved to ${d.savePath}`),
    ];
    if (d.size) lines.push(el('div', { className: 'dl-line hint' }, `Size: ${formatBytes(d.size)}`));
    if (d.titleMatch === true) {
      lines.push(el('div', { className: 'dl-check ok' }, `✓ Opened the ePUB — embedded title “${d.embeddedTitle}” matches your search.`));
    } else if (d.titleMatch === false) {
      lines.push(el('div', { className: 'dl-check warn' },
        `⚠ The ePUB’s embedded title is “${d.embeddedTitle}”, which doesn’t match “${result.title}”. Send only if you’re sure it’s the right book.`));
    } else {
      lines.push(el('div', { className: 'dl-check ok' }, '✓ Valid ePUB (no embedded title was available to compare).'));
    }
    box.append(el('div', { className: 'dl-success-panel' }, lines));

    if (d.id) {
      const sendBtn = el('button', { className: 'primary-btn send-btn', type: 'button' }, '📧 Send to readers');
      sendBtn.addEventListener('click', () =>
        openSendModal({
          downloadId: d.id,
          book: {
            title: $('#title').value.trim() || result.title,
            author: result.author,
            cover: result.cover,
            description: data.description || result.description || '',
            filename: d.filename,
          },
        })
      );
      box.append(sendBtn);
    }
  } else if (d && !d.verified) {
    $('#dlHeading').textContent = 'Saved, but not verified';
    $('#dlHeading').className = 'dl-warn-head';
    box.append(el('div', { className: 'dl-check warn' },
      `⚠ ${d.filename} was saved to ${d.savePath} but failed the ePUB check, so it isn’t offered for sending.`));
  } else {
    // Nothing downloaded — explain why, mirror by mirror.
    $('#dlHeading').textContent = 'Download failed';
    $('#dlHeading').className = 'dl-fail-head';
    const errs = data.errors || [];
    if (errs.length) {
      box.append(el('p', { className: 'hint' }, 'Every mirror failed:'));
      const ul = el('ul', { className: 'dl-errors' }, errs.map((e) => el('li', {}, `✕ ${e.error}`)));
      box.append(ul);
    } else {
      box.append(el('div', { className: 'dl-check warn' }, 'Nothing was downloaded.'));
    }
  }
}

function renderDownloadError(message, needWarm) {
  $('#dlHeading').textContent = 'Download failed';
  $('#dlHeading').className = 'dl-fail-head';
  const box = $('#dlResult');
  box.innerHTML = '';
  box.append(el('div', { className: 'dl-check warn' }, `✕ ${message}`));
  if (needWarm) {
    box.append(el('a', { className: 'warm-btn', href: '/warm', target: '_blank', rel: 'noopener' }, 'Re-warm session ↗'));
  }
  $('#dlClose').hidden = false;
}

// Lightweight dependency-free confetti burst.
function celebrate() {
  const colors = ['#ffd166', '#06d6a0', '#118ab2', '#ef476f', '#8338ec'];
  const card = downloadModal.querySelector('.modal-card');
  for (let i = 0; i < 80; i++) {
    const c = el('span', { className: 'confetti' });
    c.style.left = Math.random() * 100 + '%';
    c.style.background = colors[i % colors.length];
    c.style.animationDelay = Math.random() * 0.3 + 's';
    c.style.animationDuration = 0.9 + Math.random() * 0.8 + 's';
    card.append(c);
    setTimeout(() => c.remove(), 2200);
  }
}

function formatBytes(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
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
    const { result, btn } = pendingPremium;
    pendingPremium = null;
    premiumDownload(result, btn);
  }
});

function openCredModal() { credModal.hidden = false; $('#premUser').focus(); }
function closeCredModal() { credModal.hidden = true; }

// ---------------------------------------------------------------------------
// Send / notify
// ---------------------------------------------------------------------------
const sendModal = $('#sendModal');
let sendCtx = null;
let recipientsCache = [];

async function openSendModal(ctx) {
  sendCtx = ctx;
  const b = ctx.book;
  $('#sendBookLabel').textContent =
    `${b.title || b.filename}${b.author ? ' — ' + b.author : ''}`;
  $('#sendResults').innerHTML = '';
  $('#managePanel').hidden = true;
  await loadChannels();
  await loadRecipients();
  sendModal.hidden = false;
}
function closeSendModal() { sendModal.hidden = true; sendCtx = null; }

async function loadChannels() {
  try {
    const s = await fetch('/api/notify/status').then((r) => r.json());
    const on = s.channels.filter((c) => c.configured).map((c) => c.label);
    const msg = on.length
      ? `Sending via: ${on.join(', ')}`
      : '⚠️ No notification channel configured — set SMTP_* in .env.';
    $('#sendChannels').textContent = msg;
  } catch {
    $('#sendChannels').textContent = '';
  }
}

async function loadRecipients() {
  const data = await fetch('/api/recipients').then((r) => r.json());
  recipientsCache = data.recipients || [];
  const list = $('#recipientList');
  list.innerHTML = '';
  if (!recipientsCache.length) {
    list.append(el('p', { className: 'hint' }, 'No recipients yet — add one via “Manage recipients”.'));
  }
  for (const r of recipientsCache) {
    const id = 'rc_' + r.id;
    const cb = el('input', { type: 'checkbox', id, value: r.id });
    const tag = r.kindleEmail ? ' 📖' : '';
    list.append(el('label', { className: 'recip-row', htmlFor: id }, [cb, ` ${r.name} (${r.email})${tag}`]));
  }
  renderManageList();
}

function renderManageList() {
  const ml = $('#manageList');
  ml.innerHTML = '';
  for (const r of recipientsCache) {
    const del = el('button', { className: 'ghost-btn', type: 'button' }, 'Delete');
    del.addEventListener('click', async () => {
      await fetch('/api/recipients/' + r.id, { method: 'DELETE' });
      await loadRecipients();
    });
    ml.append(
      el('div', { className: 'manage-row' }, [
        el('span', {}, `${r.name} · ${r.email}${r.kindleEmail ? ' · ' + r.kindleEmail : ''}`),
        del,
      ])
    );
  }
}

function renderSendResults(results) {
  const box = $('#sendResults');
  box.innerHTML = '';
  for (const r of results) {
    const parts = [];
    if (r.kindle) {
      parts.push(
        r.kindle.ok ? 'Kindle ✓' : r.kindle.skipped ? 'Kindle skipped' : 'Kindle ✕ ' + r.kindle.error
      );
    }
    for (const c of r.channels) {
      parts.push(c.ok ? `${c.channel} ✓` : c.skipped ? `${c.channel} skipped (${c.error})` : `${c.channel} ✕ ${c.error}`);
    }
    const ok =
      (!r.kindle || r.kindle.ok || r.kindle.skipped) && r.channels.every((c) => c.ok || c.skipped);
    box.append(el('div', { className: 'dl-result' + (ok ? '' : ' err') }, `${r.name}: ${parts.join(' · ')}`));
  }
}

$('#sendCancel').addEventListener('click', closeSendModal);
$('#manageToggle').addEventListener('click', () => {
  const p = $('#managePanel');
  p.hidden = !p.hidden;
});

$('#recipForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name: $('#rName').value,
    email: $('#rEmail').value,
    kindleEmail: $('#rKindle').value,
    phone: $('#rPhone').value,
    carrier: $('#rCarrier').value,
  };
  const res = await fetch('/api/recipients', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Could not add recipient'); return; }
  e.target.reset();
  await loadRecipients();
});

$('#sendGo').addEventListener('click', async () => {
  if (!sendCtx) return;
  const ids = recipientsCache.filter((r) => $('#rc_' + r.id) && $('#rc_' + r.id).checked).map((r) => r.id);
  const box = $('#sendResults');
  if (!ids.length) {
    box.innerHTML = '';
    box.append(el('div', { className: 'dl-result err' }, 'Pick at least one recipient.'));
    return;
  }
  const go = $('#sendGo');
  go.disabled = true;
  go.textContent = 'Sending…';
  try {
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        downloadId: sendCtx.downloadId,
        recipientIds: ids,
        book: sendCtx.book,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Send failed');
    renderSendResults(data.results);
  } catch (err) {
    box.innerHTML = '';
    box.append(el('div', { className: 'dl-result err' }, err.message));
  } finally {
    go.disabled = false;
    go.textContent = 'Send';
  }
});

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
