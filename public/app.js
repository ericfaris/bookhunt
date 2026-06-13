'use strict';

const $ = (sel) => document.querySelector(sel);

const searchForm = $('#searchForm');
const searchBtn = $('#searchBtn');
const statusEl = $('#status');
const resultsEl = $('#results');

// Pending download to resume after credentials are entered.
let pendingPremium = null;
// Pending batch download (list of selected rows) to resume after credentials.
let pendingBatchDownload = null;

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
// Paste → auto-fill title/author. One smart button: an Amazon link is scraped
// via /api/amazon (as before); plain "Title — Author" / "Title, Author" text is
// parsed and filled directly, with NO network call.
// ---------------------------------------------------------------------------
const AMAZON_RE = /amazon\.|a\.co\b|amzn\./i;
const pasteBtn = $('#pasteAmazon');

// Split a plain line into { title, author } — mirrors the server-side batch
// convention (batch.splitTitleAuthor): first SPACED dash (— – -), else the first
// comma, else the whole line is a title-only entry. A hyphenated title with no
// surrounding spaces ("Spider-Man") stays intact.
function splitTitleAuthor(line) {
  const dash = line.match(/^(.*?)\s+[—–-]\s+(.*)$/);
  if (dash) return { title: dash[1].trim(), author: dash[2].trim() };
  const ci = line.indexOf(',');
  if (ci >= 0) return { title: line.slice(0, ci).trim(), author: line.slice(ci + 1).trim() };
  return { title: line.trim(), author: '' };
}

pasteBtn.addEventListener('click', async () => {
  // Prefer the clipboard; fall back to a prompt if it's blocked or empty.
  let text = '';
  try { text = ((await navigator.clipboard.readText()) || '').trim(); } catch { /* blocked */ }
  if (!text) {
    text = (window.prompt('Paste an Amazon link, or “Title — Author”:') || '').trim();
  }
  if (!text) return;

  // Plain text (not an Amazon link) → parse and fill directly, no scrape.
  if (!AMAZON_RE.test(text)) {
    const { title, author } = splitTitleAuthor(text.split(/\r?\n/)[0].trim());
    if (!title) {
      showStatus("Couldn't read a title from that. Paste an Amazon link or “Title — Author”.", 'error');
      return;
    }
    $('#title').value = title;
    $('#author').value = author;
    showStatus(author ? `Filled: “${title}” by ${author}` : `Filled title: “${title}”`);
    setTimeout(hideStatus, 2500);
    return;
  }

  // Amazon link → scrape the product page for title/author.
  const original = pasteBtn.textContent;
  pasteBtn.disabled = true;
  pasteBtn.textContent = 'Reading…';
  showStatusHTML('<span class="spinner"></span>Reading the Amazon page…');
  try {
    const res = await fetch('/api/amazon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: text }),
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

// Remembered so the "Retry" affordance on a failed/stalled search can re-run it.
let lastSearchParams = null;

async function runSearch({ title, author, sort }) {
  lastSearchParams = { title, author, sort };
  resultsEl.innerHTML = '';
  searchBtn.disabled = true;
  searchBtn.textContent = 'Searching…';
  startSearchTimer();

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
        } else if (ev.step === 'corrected') {
          applyCorrection(ev);
        } else if (ev.step === 'error') {
          finished = true;
          renderSearchError(ev);
        } else if (ev.step === 'done') {
          finished = true;
          stopSearchTimer();
          if (!ev.results.length) {
            renderNotFound(ev.fallbackLinks);
          } else {
            ev.results.forEach(renderCard);
            // Brief success confirmation, then get out of the way.
            showStatus(`✓ Found ${ev.results.length} match${ev.results.length === 1 ? '' : 'es'}.`);
            setTimeout(hideStatus, 2500);
          }
        }
      }
    }
    if (!finished) {
      renderSearchError({
        message: 'The search ended unexpectedly.',
        hint: 'The Mobilism session may have dropped — re-warm it and try again.',
        retryable: true,
        needWarm: true,
      });
    }
  } catch (err) {
    renderSearchError({ message: err.message || 'Search failed.', hint: 'Please try again.', retryable: true });
  } finally {
    stopSearchTimer();
    searchBtn.disabled = false;
    searchBtn.textContent = 'Search';
  }
}

// --- Live search status: phase label + elapsed time + expectation ----------
let searchTimer = null;
let searchStart = 0;
let lastPhaseText = 'Searching Mobilism…';

function startSearchTimer() {
  searchStart = Date.now();
  lastPhaseText = 'Searching Mobilism…';
  clearInterval(searchTimer);
  renderSearchStatus();
  searchTimer = setInterval(renderSearchStatus, 1000);
}
function stopSearchTimer() { clearInterval(searchTimer); searchTimer = null; }

function renderSearchStatus() {
  const secs = Math.floor((Date.now() - searchStart) / 1000);
  // Distinguish "slow but working" from "stuck": after ~45s the copy changes so
  // the user knows long is expected, not frozen — the elapsed counter ticking
  // is itself the heartbeat that the app is alive.
  const expectation = secs < 45
    ? 'usually 20–45s · polite delays between requests'
    : 'taking longer than usual — still working, hang tight';
  showStatusHTML(
    `<span class="spinner"></span>${lastPhaseText} <span class="hint">(${secs}s · ${expectation})</span>`
  );
}

// Map a backend search phase to friendly status text (the elapsed timer keeps
// ticking around it via renderSearchStatus).
function showSearchProgress(ev) {
  const msgs = {
    'title-search': 'Searching Mobilism titles…',
    'scanning': `Scanning results…${ev.found ? ` (${ev.found} found so far)` : ''}`,
    'collections': 'Checking collection posts…',
    'author-collections': 'Looking for “books by author” sets…',
    'author-fallback': 'Broadening to an author search…',
  };
  lastPhaseText = msgs[ev.phase] || 'Searching Mobilism…';
  renderSearchStatus();
}

// A spelling correction landed before the scrape. Reflect the corrected terms
// in the input fields (so a download/resend logs the clean spelling), keep retry
// in sync, and pin a before→after notice above the results.
function applyCorrection(ev) {
  $('#title').value = ev.title || '';
  $('#author').value = ev.author || '';
  if (lastSearchParams) lastSearchParams = { ...lastSearchParams, title: ev.title || '', author: ev.author || '' };
  resultsEl.prepend(buildCorrectionNotice(ev.original || {}, { title: ev.title, author: ev.author }));
}

// "✎ Corrected ‘<before>’ → ‘<after>’" — text-only (echoes external content, so
// nothing is interpreted as HTML).
function buildCorrectionNotice(before, after, cls = 'correction-notice') {
  const fmt = (o) => [o.title, o.author].filter(Boolean).join(' — ');
  const node = el('div', { className: cls });
  node.append(el('span', { className: 'corr-icon' }, '✎'));
  const text = el('span', { className: 'corr-text' });
  text.append('Corrected ');
  text.append(el('span', { className: 'corr-before' }, fmt(before)));
  text.append(' → ');
  text.append(el('span', { className: 'corr-after' }, fmt(after)));
  node.append(text);
  return node;
}

// Plain-language search error with a hint and (when transient) a Retry button.
function renderSearchError(ev) {
  stopSearchTimer();
  statusEl.hidden = false;
  statusEl.className = 'status error';
  statusEl.innerHTML = '';
  statusEl.append(el('div', { className: 'err-msg' }, ev.message || 'Search failed.'));
  if (ev.hint) statusEl.append(el('div', { className: 'err-hint' }, ev.hint));

  const actions = el('div', { className: 'err-actions' });
  if (ev.needWarm) {
    showWarmBanner(true);
    actions.append(el('a', { className: 'warm-btn', href: '/warm', target: '_blank', rel: 'noopener' }, 'Re-warm ↗'));
  }
  if (ev.retryable && lastSearchParams) {
    const retry = el('button', { className: 'ghost-btn', type: 'button' }, '↻ Retry search');
    retry.addEventListener('click', () => runSearch(lastSearchParams));
    actions.append(retry);
  }
  if (actions.childNodes.length) statusEl.append(actions);
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

  // "Request re-upload" — always available (the user decides when links are
  // dead). Asks the OP to re-upload via the forum's Reupload control.
  const reupRow = buildReuploadRow(r);

  const body = el('div', { className: 'card-body' }, [
    el('h3', {}, r.title),
    r.author ? el('p', { className: 'author' }, r.author) : null,
    badges,
    meta,
    dlRow,
    reupRow,
  ]);

  resultsEl.append(el('div', { className: 'card' }, [cover, body]));
}

// A small row under each result: a "Request re-upload" button plus an inline
// status message. Disables itself after a successful (or already-pending)
// request so the user can't spam the OP.
function buildReuploadRow(r) {
  const msg = el('span', { className: 'reup-msg hint' }, '');
  const btn = el('button', { className: 'ghost-btn reup-btn', type: 'button' }, '↻ Request re-upload');

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Requesting…';
    msg.className = 'reup-msg hint';
    msg.textContent = '';
    try {
      const res = await fetch('/api/reupload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: r.url, title: r.title }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.needWarm) {
        showWarmBanner(true);
        msg.className = 'reup-msg error';
        msg.textContent = 'Session expired — click “Re-warm ↗” above, then try again.';
        btn.disabled = false;
        btn.textContent = original;
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Re-upload request failed.');

      // success / already-requested → leave it disabled; otherwise re-enable.
      const settled = data.status === 'success' || data.status === 'already-requested';
      msg.className = 'reup-msg ' + (settled ? 'ok' : data.status === 'not-available' ? 'hint' : 'warn');
      msg.textContent = data.message || 'Done.';
      if (settled) {
        btn.textContent = data.status === 'success' ? '✓ Re-upload requested' : '✓ Already requested';
      } else {
        btn.disabled = false;
        btn.textContent = original;
      }
    } catch (err) {
      msg.className = 'reup-msg error';
      msg.textContent = err.message;
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  return el('div', { className: 'reup-row' }, [btn, msg]);
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
      stopFetchTimer();
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
      // The transload can run silently for minutes; tick an elapsed counter so
      // the step reads as "slow but working", not stuck.
      startFetchTimer(ev.host);
      break;
    case 'saved':
      stopFetchTimer();
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
      stopFetchTimer();
      setStep('fetch', 'fail', `${ev.host || 'mirror'}: ${ev.error}`);
      break;
    case 'done':
      stopFetchTimer();
      renderDownloadDone(ev, result);
      break;
    case 'error':
      stopFetchTimer();
      renderDownloadError(ev);
      break;
  }
}

// Elapsed-time ticker for the (potentially multi-minute) download step.
let dlFetchTimer = null;
let dlFetchStart = 0;
function startFetchTimer(host) {
  dlFetchStart = Date.now();
  clearInterval(dlFetchTimer);
  dlFetchTimer = setInterval(() => {
    const li = $('#dlstep-fetch');
    if (!li || !li.classList.contains('active')) return;
    const secs = Math.floor((Date.now() - dlFetchStart) / 1000);
    const base = host ? `Downloading from ${host}… ` : 'Downloading… ';
    const tail = secs > 30 ? ' — large files can take a few minutes' : '';
    li.querySelector('.dl-step-note').textContent = `${base}(${secs}s${tail})`;
  }, 1000);
}
function stopFetchTimer() { clearInterval(dlFetchTimer); dlFetchTimer = null; }

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

// Accepts either the enriched SSE error event ({ message, hint, needWarm }) or a
// plain string (client-side failures before/around the stream).
function renderDownloadError(ev) {
  const o = typeof ev === 'string' ? { message: ev } : (ev || {});
  $('#dlHeading').textContent = 'Download failed';
  $('#dlHeading').className = 'dl-fail-head';
  const box = $('#dlResult');
  box.innerHTML = '';
  box.append(el('div', { className: 'dl-check warn' }, `✕ ${o.message || 'Download failed'}`));
  if (o.hint) box.append(el('div', { className: 'dl-line hint' }, o.hint));
  if (o.needWarm) {
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
  if (pendingBatchDownload) {
    const rows = pendingBatchDownload;
    pendingBatchDownload = null;
    downloadBatchSelected(rows);
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
    // Let an opener (e.g. the Library view) refresh its inline send history.
    if (sendCtx && typeof sendCtx.onSent === 'function') sendCtx.onSent();
  } catch (err) {
    box.innerHTML = '';
    box.append(el('div', { className: 'dl-result err' }, err.message));
  } finally {
    go.disabled = false;
    go.textContent = 'Send';
  }
});

// ---------------------------------------------------------------------------
// Library — every downloaded book with its send history inline + resend
// ---------------------------------------------------------------------------
const libraryPanel = $('#libraryPanel');
const libraryList = $('#libraryList');
$('#libraryToggle').addEventListener('click', openLibrary);
$('#libraryClose').addEventListener('click', closeLibrary);

async function openLibrary() {
  libraryPanel.hidden = false;
  $('#overlay').hidden = false;
  renderLibrarySkeleton();
  try {
    const data = await fetch('/api/library').then((r) => r.json());
    renderLibrary(data.books || []);
  } catch {
    libraryList.innerHTML = '';
    libraryList.append(
      el('div', { className: 'lib-empty' }, [
        el('div', { className: 'lib-empty-icon' }, '⚠️'),
        el('p', {}, 'Couldn’t load your library. Please try again.'),
      ])
    );
  }
}
function closeLibrary() {
  libraryPanel.hidden = true;
  $('#overlay').hidden = true;
}

// Shimmer placeholders while the library loads — keeps the drawer from flashing
// empty (and reduced-motion users get a static muted block, see CSS).
function renderLibrarySkeleton() {
  libraryList.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    libraryList.append(
      el('div', { className: 'lib-book skeleton' }, [
        el('div', { className: 'sk-line sk-title' }),
        el('div', { className: 'sk-line sk-sub' }),
        el('div', { className: 'sk-line sk-row' }),
      ])
    );
  }
}

function renderLibrary(books) {
  libraryList.innerHTML = '';
  if (!books.length) {
    libraryList.append(
      el('div', { className: 'lib-empty' }, [
        el('div', { className: 'lib-empty-icon' }, '📭'),
        el('p', {}, 'No books yet.'),
        el('p', { className: 'hint' }, 'Download a book and it’ll show up here with its send history.'),
      ])
    );
    return;
  }
  for (const book of books) libraryList.append(renderLibraryBook(book));
}

function renderLibraryBook(book) {
  const badges = el('div', { className: 'badges' }, [
    el('span', { className: 'badge' }, (book.mode === 'standard' ? 'External' : 'Premium')),
    book.verified ? el('span', { className: 'badge ok-badge' }, 'Verified ✓') : null,
  ]);

  const metaBits = [];
  if (book.size) metaBits.push(el('span', {}, `📦 ${formatBytes(book.size)}`));
  if (book.acquiredAt) metaBits.push(el('span', {}, `📅 ${formatDate(book.acquiredAt)}`));
  const meta = el('div', { className: 'meta' }, metaBits);

  // Inline send history.
  const sendsWrap = el('div', { className: 'lib-sends' });
  if (!book.sends.length) {
    sendsWrap.append(el('div', { className: 'lib-notsent' }, 'Not sent yet'));
  } else {
    sendsWrap.append(el('div', { className: 'lib-sends-head' }, `Sent ${book.sends.length}×`));
    for (const s of book.sends) sendsWrap.append(renderSend(s));
  }

  // Resend — reuses the send modal; disabled when the file is gone from disk.
  const actions = el('div', { className: 'lib-actions' });
  if (book.filePresent) {
    const resend = el('button', { className: 'primary-btn lib-resend', type: 'button' },
      book.sends.length ? '📧 Resend' : '📧 Send to readers');
    resend.addEventListener('click', () =>
      openSendModal({
        downloadId: book.id,
        book: { title: book.title, filename: book.filename },
        onSent: openLibrary, // refresh inline history after a send
      })
    );
    actions.append(resend);
  } else {
    actions.append(
      el('div', { className: 'lib-missing' }, '⚠ File removed from disk — re-download to send again.')
    );
  }

  return el('div', { className: 'lib-book' }, [
    el('h3', { className: 'lib-title' }, book.title || book.filename || 'Untitled'),
    book.filename && book.filename !== book.title
      ? el('div', { className: 'lib-filename hint' }, book.filename)
      : null,
    badges,
    meta,
    sendsWrap,
    actions,
  ]);
}

function renderSend(s) {
  const who = (s.to || []).join(', ') || 'someone';
  const bits = [];
  if (s.kindlePushed) bits.push('Kindle 📖');
  for (const c of s.channels || []) {
    if (c.ok) bits.push(c.channel);
  }
  const via = bits.length ? ` · ${bits.join(', ')}` : '';
  return el('div', { className: 'lib-send' }, [
    el('span', { className: 'lib-send-who' }, `→ ${who}`),
    el('span', { className: 'lib-send-meta hint' }, `${formatDate(s.timestamp)}${via}`),
  ]);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
const historyPanel = $('#historyPanel');
const overlay = $('#overlay');
$('#historyToggle').addEventListener('click', openHistory);
$('#historyClose').addEventListener('click', closeHistory);
overlay.addEventListener('click', () => { closeHistory(); closeLibrary(); });

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
  } else if (entry.type === 'reupload') {
    const label = { success: 'requested', 'already-requested': 'already pending' }[entry.status] || entry.status;
    item.append(el('div', {}, `↻ Re-upload ${label}${entry.title ? ` — “${entry.title}”` : ''}`));
  } else {
    const where = entry.savePath ? ` → ${entry.savePath}` : '';
    item.append(el('div', {}, `⬇ ${entry.filename || 'download'}${where}`));
    if (entry.title) item.append(el('div', { className: 'hint' }, entry.title));
  }
  item.append(when);
  return item;
}

// ---------------------------------------------------------------------------
// Batch mode — search a pasted list, then download & send selected titles
// ---------------------------------------------------------------------------
const batchModal = $('#batchModal');
const batchInput = $('#batchInput');
const batchRows = new Map(); // index → { entry, status, match, candidates, downloadId, filename, els }

$('#batchToggle').addEventListener('click', openBatchModal);
$('#batchCancel').addEventListener('click', () => { batchModal.hidden = true; });
$('#batchInput').addEventListener('input', updateBatchCount);
$('#batchGo').addEventListener('click', startBatch);
$('#batchPaste').addEventListener('click', async () => {
  try {
    const text = (await navigator.clipboard.readText()) || '';
    if (text.trim()) {
      batchInput.value = batchInput.value ? batchInput.value.replace(/\s*$/, '\n') + text : text;
      updateBatchCount();
    }
  } catch { /* clipboard blocked — the user can paste manually */ }
});

function openBatchModal() {
  batchModal.hidden = false;
  updateBatchCount();
  batchInput.focus();
}

// Mirror the server parser closely enough to give live feedback: non-blank
// lines, capped at 50 (see batch.MAX_BATCH server-side).
function parseBatchLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 50);
}
function updateBatchCount() {
  const n = parseBatchLines(batchInput.value).length;
  const raw = String(batchInput.value || '').split(/\r?\n/).filter((l) => l.trim()).length;
  const capped = raw > 50 ? ` (capped from ${raw})` : '';
  $('#batchCount').textContent = n ? `${n} book${n === 1 ? '' : 's'} detected${capped}` : 'No books yet';
}

// Shared SSE frame reader (data: {…}\n\n, with `: ping` heartbeats).
async function consumeSSE(res, onEvent) {
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
      let ev;
      try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      onEvent(ev);
    }
  }
}

async function startBatch() {
  const text = batchInput.value;
  if (!parseBatchLines(text).length) return;
  const sort = $('#batchSort').value;
  batchModal.hidden = true;

  // Take over the results area with the batch view.
  hideStatus();
  resultsEl.innerHTML = '';
  batchRows.clear();
  const header = el('div', { className: 'batch-header' }, [
    el('h2', { className: 'batch-title' }, 'Batch results'),
    el('div', { className: 'batch-progress', id: 'batchProgress' }, [
      el('span', { className: 'spinner' }), 'Starting…',
    ]),
  ]);
  const rowsWrap = el('div', { className: 'batch-rows', id: 'batchRowsWrap' });
  const actionBar = el('div', { className: 'batch-actionbar', id: 'batchActionBar', hidden: true });
  resultsEl.append(header, rowsWrap, actionBar);

  try {
    const res = await fetch('/api/search/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sort }),
    });
    if (res.status === 409) {
      const data = await res.json().catch(() => ({}));
      showWarmBanner(true);
      setBatchProgress(`⚠ ${data.error || 'Session expired.'}`, false);
      return;
    }
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Batch search failed');
    }
    await consumeSSE(res, handleBatchEvent);
  } catch (err) {
    setBatchProgress(`✕ ${err.message}`, false);
  }
}

function setBatchProgress(text, spinning = true) {
  const p = $('#batchProgress');
  if (!p) return;
  p.innerHTML = '';
  if (spinning) p.append(el('span', { className: 'spinner' }));
  p.append(document.createTextNode(text));
}

function handleBatchEvent(ev) {
  switch (ev.step) {
    case 'start':
      ev.entries.forEach((entry, i) => createBatchRow(i + 1, entry));
      setBatchProgress(`Searching ${ev.total} book${ev.total === 1 ? '' : 's'}…`);
      break;
    case 'searching':
      setBatchProgress(`Searching ${ev.index} of ${ev.total}… “${ev.title}”`);
      setRowPill(ev.index, 'searching', 'Searching…');
      break;
    case 'entry':
      fillBatchRow(ev.index, ev);
      break;
    case 'done':
      setBatchProgress(`✓ Done — ${ev.found} of ${ev.total} found.`, false);
      finishBatchSearch();
      break;
    case 'error':
      setBatchProgress(`✕ ${ev.message || ev.error || 'Batch failed.'}`, false);
      if (ev.needWarm) showWarmBanner(true);
      finishBatchSearch();
      break;
  }
}

function createBatchRow(index, entry) {
  const pill = el('span', { className: 'batch-pill searching' }, 'Queued');
  const body = el('div', { className: 'batch-row-body' });
  const requested = el('div', { className: 'batch-req' }, [
    el('span', { className: 'batch-req-title' }, entry.title),
    entry.author ? el('span', { className: 'batch-req-author' }, ` — ${entry.author}`) : null,
  ]);
  const row = el('div', { className: 'batch-row', id: 'batchrow-' + index }, [
    el('div', { className: 'batch-row-head' }, [requested, pill]),
    body,
  ]);
  $('#batchRowsWrap').append(row);
  batchRows.set(index, { entry, status: 'searching', els: { pill, body }, selected: false });
}

function setRowPill(index, status, label) {
  const r = batchRows.get(index);
  if (!r) return;
  r.els.pill.className = 'batch-pill ' + status;
  r.els.pill.textContent = label;
}

function fillBatchRow(index, ev) {
  const r = batchRows.get(index);
  if (!r) return;
  r.status = ev.status;
  const body = r.els.body;
  body.innerHTML = '';

  // A spelling correction ran before this entry's search. Pin a before→after
  // line and adopt the corrected spelling so the download/send (which uses
  // r.entry.title) logs the clean version into History/Library.
  if (ev.corrected) {
    r.entry = { title: ev.title || r.entry.title, author: ev.author || '' };
    body.append(buildCorrectionNotice(ev.original || {}, { title: ev.title, author: ev.author }, 'batch-correction'));
  }

  if (ev.status === 'not-found') {
    setRowPill(index, 'notfound', 'Not found');
    const links = el('div', { className: 'batch-links' });
    if (ev.fallbackLinks?.title) links.append(el('a', { href: ev.fallbackLinks.title, target: '_blank', rel: 'noopener' }, 'Title search ↗'));
    if (ev.fallbackLinks?.author) links.append(el('a', { href: ev.fallbackLinks.author, target: '_blank', rel: 'noopener' }, 'Author search ↗'));
    body.append(el('div', { className: 'hint' }, 'No ePUB match. Try the manual searches:'), links);
    return;
  }
  if (ev.status === 'error') {
    setRowPill(index, 'error', 'Error');
    body.append(el('div', { className: 'batch-err' }, ev.error || 'Search failed.'));
    if (ev.hint) body.append(el('div', { className: 'hint' }, ev.hint));
    if (ev.needWarm) body.append(el('a', { className: 'warm-btn', href: '/warm', target: '_blank', rel: 'noopener' }, 'Re-warm ↗'));
    return;
  }

  // found / multiple → selectable, with the best match preselected.
  const results = ev.results || [];
  r.candidates = results;
  r.selectedCandidate = 0;
  r.selected = true;
  setRowPill(index, ev.status === 'multiple' ? 'multiple' : 'found', ev.status === 'multiple' ? `${results.length} matches` : 'Found ✓');

  const cb = el('input', { type: 'checkbox', id: 'batchsel-' + index, checked: true });
  cb.addEventListener('change', () => { r.selected = cb.checked; updateBatchActionBar(); });

  let chosenLabel;
  if (ev.status === 'multiple') {
    const sel = el('select', { className: 'batch-candidate' },
      results.map((res, i) => el('option', { value: String(i) }, `${res.title}${res.premium ? ' (Premium)' : ''}`)));
    sel.addEventListener('change', () => { r.selectedCandidate = Number(sel.value); });
    chosenLabel = sel;
  } else {
    chosenLabel = el('span', { className: 'batch-match' }, `${results[0].title}${results[0].premium ? '' : ' (external links)'}`);
  }

  const noteEl = el('div', { className: 'batch-note', id: 'batchnote-' + index });
  r.els.note = noteEl;
  body.append(
    el('label', { className: 'batch-select', htmlFor: 'batchsel-' + index }, [cb, chosenLabel]),
    noteEl
  );
  updateBatchActionBar();
}

function finishBatchSearch() {
  const bar = $('#batchActionBar');
  if (!bar) return;
  bar.hidden = false;
  updateBatchActionBar();
}

function selectableRows() {
  return [...batchRows.values()].filter((r) => (r.status === 'found' || r.status === 'multiple') && r.candidates && r.candidates.length);
}

function updateBatchActionBar() {
  const bar = $('#batchActionBar');
  if (!bar || bar.hidden) return;
  const selected = selectableRows().filter((r) => r.selected && !r.downloadId);
  bar.innerHTML = '';
  const btn = el('button', { className: 'primary-btn', type: 'button', disabled: !selected.length },
    `⬇ Download selected (${selected.length})`);
  btn.addEventListener('click', () => downloadBatchSelected(selected));
  bar.append(btn);
}

async function downloadBatchSelected(rows) {
  // Make sure premium creds exist once before grinding through the list.
  const status = await fetch('/api/premium/status').then((r) => r.json()).catch(() => ({}));
  if (!status.hasCreds) {
    pendingBatchDownload = rows;
    openCredModal();
    return;
  }

  const bar = $('#batchActionBar');
  if (bar) bar.querySelectorAll('button').forEach((b) => (b.disabled = true));

  for (const r of rows) {
    if (r.downloadId) continue; // already done in a previous pass
    const chosen = r.candidates[r.selectedCandidate || 0];
    const note = r.els.note;
    setNote(note, 'working', '⏳ Starting…');
    try {
      await downloadOneBatch(r, chosen, note);
    } catch (err) {
      // Per-book isolation: a failure here never stops the rest of the list.
      setNote(note, 'fail', `✕ ${err.message}`);
    }
  }

  updateBatchActionBar();
  if (bar) bar.querySelectorAll('button').forEach((b) => (b.disabled = false));
}

function setNote(note, kind, text) {
  if (!note) return;
  note.className = 'batch-note ' + (kind || '');
  note.textContent = text;
}

// Drives one book through /api/download and reflects progress on its row. On
// success it stamps the row's downloadId and reveals a per-book "Send" button.
async function downloadOneBatch(r, chosen, note) {
  const res = await fetch('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: chosen.url, title: chosen.title, searchedTitle: r.entry.title }),
  });
  if (res.status === 401) {
    const data = await res.json().catch(() => ({}));
    if (data.needCreds) {
      pendingBatchDownload = selectableRows().filter((x) => x.selected && !x.downloadId);
      openCredModal();
      throw new Error('Premium credentials needed.');
    }
  }
  if (!res.ok || !res.body) throw new Error('Download request failed (HTTP ' + res.status + ')');

  let finished = false;
  await consumeSSE(res, (ev) => {
    switch (ev.step) {
      case 'reading-post': setNote(note, 'working', '⏳ Reading post…'); break;
      case 'mirrors-found': setNote(note, 'working', `⏳ ${ev.total} mirror${ev.total === 1 ? '' : 's'} found`); break;
      case 'mirror': setNote(note, 'working', `⏳ Mirror ${ev.index}/${ev.total}${ev.host ? ' · ' + ev.host : ''}`); break;
      case 'downloading': setNote(note, 'working', `⏳ Downloading${ev.host ? ' from ' + ev.host : ''}…`); break;
      case 'verifying': setNote(note, 'working', '⏳ Verifying the ePUB…'); break;
      case 'done': {
        finished = true;
        const d = (ev.downloads || [])[0];
        if (d && d.verified) {
          r.downloadId = d.id;
          r.filename = d.filename;
          const ok = d.titleMatch !== false;
          setNote(note, ok ? 'ok' : 'warn', ok ? `✓ Downloaded — ${d.filename}` : `⚠ Downloaded — verify it's the right book (${d.embeddedTitle || '?'})`);
          addBatchSendButton(r, note);
        } else if (d) {
          setNote(note, 'warn', `⚠ Saved but failed the ePUB check`);
        } else {
          const errs = ev.errors || [];
          setNote(note, 'fail', `✕ ${errs.length ? errs[0].error : 'Download failed'}`);
        }
        break;
      }
      case 'error':
        finished = true;
        setNote(note, 'fail', `✕ ${ev.message || ev.error || 'Download failed'}`);
        if (ev.needWarm) showWarmBanner(true);
        break;
    }
  });
  if (!finished) setNote(note, 'fail', '✕ Download ended unexpectedly');
}

function addBatchSendButton(r, note) {
  const send = el('button', { className: 'ghost-btn batch-send', type: 'button' }, '📧 Send');
  send.addEventListener('click', () =>
    openSendModal({
      downloadId: r.downloadId,
      book: { title: r.entry.title, filename: r.filename },
    })
  );
  // Place the Send button right after the note.
  note.after(send);
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
