'use strict';

// Register the PWA service worker (issue #18). Inline scripts are blocked by our
// CSP, so registration lives here in app.js (an allowed 'self' script).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* non-fatal */ });
  });
}

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
  // While a search is running the button is in "Cancel" mode — pressing Enter
  // should never kick off a second search. The button's own click handler does
  // the cancelling.
  if (searchAbort) return;

  const title = $('#title').value.trim();
  const author = $('#author').value.trim();
  const sort = $('#sort').value;

  if (!title && !author) {
    showStatus('Enter a title and/or an author.', 'error');
    return;
  }

  runSearch({ title, author, sort });
});

// When a search is in flight the Search button becomes a Cancel button: clicking
// it aborts the fetch (which closes the stream → the server cancels the scrape).
searchBtn.addEventListener('click', (e) => {
  if (searchAbort) {
    e.preventDefault(); // don't also submit the form
    searchAbort.abort();
  }
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
// Deep-link prefill — lets the BookHunt browser extension (or a bookmarklet)
// hand a book off straight from an Amazon page. Supported query params:
//   ?title=…&author=…   fill the fields directly and search (no network call)
//   ?amazon=<url>       scrape the product page via /api/amazon, then search
//   &go=0               fill only; skip the auto-search
// Params are stripped from the URL afterward so a refresh doesn't re-fire.
// ---------------------------------------------------------------------------
async function prefillFromQuery() {
  const q = new URLSearchParams(location.search);
  const sort = $('#sort').value;
  const auto = q.get('go') !== '0';
  const strip = () => history.replaceState(null, '', location.pathname);

  const title = (q.get('title') || '').trim();
  const author = (q.get('author') || '').trim();
  if (title || author) {
    $('#title').value = title;
    $('#author').value = author;
    strip();
    if (auto) runSearch({ title, author, sort });
    return;
  }

  const amazon = (q.get('amazon') || '').trim();
  if (!amazon || !AMAZON_RE.test(amazon)) return;
  strip();
  showStatusHTML('<span class="spinner"></span>Reading the Amazon page…');
  try {
    const res = await fetch('/api/amazon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: amazon }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lookup failed');
    if (data.title) $('#title').value = data.title;
    if (data.author) $('#author').value = data.author;
    if (auto && (data.title || data.author)) {
      runSearch({ title: data.title || '', author: data.author || '', sort });
    } else {
      showStatus(`Filled from Amazon: “${data.title || '?'}” by ${data.author || '?'}`);
      setTimeout(hideStatus, 2500);
    }
  } catch (err) {
    showStatus(err.message, 'error');
  }
}

// NOTE: prefillFromQuery() is invoked at the very bottom of this file, not here.
// It calls runSearch(), which reads module-level `let` bindings (lastSearchParams
// et al.) declared further down — calling it early hits their temporal dead zone.

// ---------------------------------------------------------------------------
// Session warmth banner
// ---------------------------------------------------------------------------
const warmBanner = $('#warmBanner');

// Rotating, tongue-in-cheek "we're on it" status lines — the movement that tells
// the user the warm-up is actively churning (paired with the steaming mug + the
// sliding shimmer in CSS). Cycled only while the banner is visible.
const WARM_LINES = [
  'Warming up the reading room…',
  'Brewing a fresh session…',
  'Coaxing Cloudflare with a warm cookie…',
  'Dusting off the card catalog…',
  'Stoking the embers…',
  'Sweet-talking the Mobilism doorman…',
  'Fluffing the beanbags…',
  'Re-shelving by vibe, not by spine…',
];
let warmRotator = null;
let warmLineIdx = 0;
function startWarmRotator() {
  if (warmRotator) return;
  const head = document.getElementById('warmHeadline');
  if (!head) return;
  warmRotator = setInterval(() => {
    warmLineIdx = (warmLineIdx + 1) % WARM_LINES.length;
    head.classList.remove('swap');
    void head.offsetWidth; // reflow so the fade-in animation restarts
    head.textContent = WARM_LINES[warmLineIdx];
    head.classList.add('swap');
  }, 3500);
}
function stopWarmRotator() {
  if (warmRotator) { clearInterval(warmRotator); warmRotator = null; }
}

function showWarmBanner(show) {
  warmBanner.hidden = !show;
  if (show) startWarmRotator();
  else stopWarmRotator();
}

// Manual "Log into Mobilism" button — fills env creds + submits on the live
// browser server-side, so the password never has to be typed into noVNC. Handy
// right after clearing a Cloudflare challenge in /warm (the auto-warm watcher
// would get to it within ~20s, but this triggers it instantly).
const warmLoginBtn = $('#warmLoginBtn');
if (warmLoginBtn) {
  warmLoginBtn.addEventListener('click', async () => {
    const label = warmLoginBtn.textContent;
    warmLoginBtn.disabled = true;
    warmLoginBtn.textContent = 'Logging in…';
    try {
      const r = await fetch('/api/session/login', { method: 'POST' }).then((res) => res.json());
      if (r.ready || (r.session && r.session.ready)) {
        showWarmBanner(false);
      } else if (r.humanNeeded) {
        warmLoginBtn.textContent = 'Clear Cloudflare in /warm ↗';
        window.open('/warm', '_blank', 'noopener');
      }
    } catch {
      /* leave the banner; the watcher will keep trying */
    } finally {
      warmLoginBtn.disabled = false;
      if (warmLoginBtn.textContent === 'Logging in…') warmLoginBtn.textContent = label;
      refreshSessionStatus();
    }
  });
}

async function refreshSessionStatus() {
  try {
    const s = await fetch('/api/session/status').then((r) => r.json());
    // Show the warming banner whenever the session isn't ready to search —
    // including a cold boot where the browser hasn't come up yet (issue #29).
    // Previously we only nagged once `browser === true`, which suppressed the
    // banner in exactly the worst case: the user searched, waited 30s, and only
    // then learned Mobilism was warming. The server-side auto-warm watcher is
    // already churning in the background, so surfacing it up front is honest.
    showWarmBanner(!s.ready);
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
// AbortController for the in-flight search; non-null only while one is running
// (also the flag the submit/click handlers use to switch to "Cancel" mode).
let searchAbort = null;

async function runSearch({ title, author, sort }) {
  lastSearchParams = { title, author, sort };
  resultsEl.innerHTML = '';
  searchAbort = new AbortController();
  // Button flips to an enabled "Cancel" — keep it clickable so the user can stop.
  searchBtn.disabled = false;
  searchBtn.textContent = 'Cancel';
  searchBtn.classList.add('cancel-btn');
  startSearchTimer();

  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, author, sort }),
      signal: searchAbort.signal,
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
        } else if (ev.step === 'library') {
          renderLibraryHits(ev.books);
        } else if (ev.step === 'error') {
          finished = true;
          renderSearchError(ev);
        } else if (ev.step === 'done') {
          finished = true;
          stopSearchTimer();
          if (!ev.results.length) {
            renderNotFound(ev.fallbackLinks, ev.externalSources);
          } else {
            showResults(ev.results);
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
    // The user cancelled — not an error. Aborting the fetch lands here.
    if (err && err.name === 'AbortError') {
      stopSearchTimer();
      showStatus('Search cancelled.');
      setTimeout(hideStatus, 2500);
    } else {
      renderSearchError({ message: err.message || 'Search failed.', hint: 'Please try again.', retryable: true });
    }
  } finally {
    stopSearchTimer();
    searchAbort = null;
    searchBtn.disabled = false;
    searchBtn.textContent = 'Search';
    searchBtn.classList.remove('cancel-btn');
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

// Trailing-edge debounce: coalesces rapid calls (e.g. keystrokes) into one.
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// Build one result card node. (renderCard appends it — kept for compatibility.)
//
// When a book was found INSIDE a multi-book set (`r.collection`), the forum
// post's title, cover and blurb all describe the whole SET, not the book the
// user searched for — which is confusing (a card titled "7 Books by …" with some
// other book's cover). For those, we foreground the searched book as the hero:
// its own title, and its real cover + synopsis fetched from the book catalog
// (/api/meta), with the set shown only as a "found inside this set" provenance
// strip that still links to (and downloads) the set thread.
function buildCard(r) {
  const inSet = !!r.collection && !!(r.matchedTitle || r.matchedAuthor);
  const heroTitle = inSet && r.matchedTitle ? r.matchedTitle : r.title;
  const heroAuthor = inSet ? (r.matchedAuthor || r.author || '') : (r.author || '');
  const setTitle = r.setTitle || r.title;

  // --- Cover slot (mutable so a set card can swap in the real book's art) ---
  const cover = el('div', { className: 'cover-slot' });
  function renderCover(src, { loading = false } = {}) {
    cover.innerHTML = '';
    if (src) {
      const img = el('img', { className: 'cover zoomable', src, alt: 'cover', loading: 'lazy', title: 'Click to enlarge' });
      img.addEventListener('click', () => openLightbox(src, heroTitle));
      cover.append(img);
    } else {
      const ph = el('div', { className: 'cover placeholder' + (loading ? ' loading' : ''), title: loading ? 'Looking up cover…' : 'No cover available' }, loading ? '' : '📖');
      cover.append(ph);
    }
  }
  // A set card ignores the post's (set) cover and looks up the real one below;
  // a normal card uses the scraped cover immediately.
  renderCover(inSet ? null : r.cover, { loading: inSet });

  const badges = el('div', { className: 'badges' }, [
    el('span', { className: 'badge' }, r.format || 'ePUB'),
    inSet
      ? el('span', { className: 'badge set', title: `Found inside the set “${setTitle}”` }, '📚 In a set')
      : el('span', { className: 'badge src' }, r.source),
    r.premium ? el('span', { className: 'badge prem' }, 'Premium') : null,
    isInLibrary(r) ? el('span', { className: 'badge ok-badge', title: 'Already in your library' }, '✓ In library') : null,
  ]);

  // Provenance strip: makes explicit that this book lives in a larger set and
  // that the download/thread is that set. Links to the set thread.
  const setNote = inSet
    ? el('div', { className: 'set-note' }, [
        el('span', { className: 'set-note-ico' }, '📚'),
        el('span', { className: 'set-note-text' }, [
          'Found inside a set — ',
          el('a', { href: r.url, target: '_blank', rel: 'noopener', className: 'set-note-link' }, setTitle),
        ]),
      ])
    : null;

  const metaBits = [];
  if (r.size) metaBits.push(el('span', {}, `📦 ${r.size}`));
  if (r.date) metaBits.push(el('span', {}, `📅 ${formatDate(r.date)}`));
  if (r.category) metaBits.push(el('span', {}, `🗂 ${r.category}`));
  const meta = el('div', { className: 'meta' }, metaBits);

  const dlRow = el('div', { className: 'dl-row' });
  if (r.premium) {
    const btn = el('button', { className: 'dl-btn premium', type: 'button' }, inSet ? 'Download set (Premium)' : 'Download (Premium)');
    btn.addEventListener('click', () => premiumDownload(r, btn));
    dlRow.append(btn);
  } else if (r.postlinks && r.postlinks.length) {
    for (const link of r.postlinks) {
      const btn = el('button', { className: 'dl-btn', type: 'button' }, link.host);
      btn.addEventListener('click', () => {
        window.open(link.url, '_blank', 'noopener');
        logStandard(link, r.title, r.author, r.cover);
      });
      dlRow.append(btn);
    }
  } else {
    dlRow.append(el('span', { className: 'hint' }, 'No download links found'));
  }
  dlRow.append(el('a', { className: 'topic-link', href: r.url, target: '_blank', rel: 'noopener' }, inSet ? 'View set thread ↗' : 'View thread ↗'));

  // "Request re-upload" — always available (the user decides when links are
  // dead). Asks the OP to re-upload via the forum's Reupload control.
  const reupRow = buildReuploadRow(r);

  // Synopsis slot (mutable so a set card can swap in the real book's blurb).
  const synopsisSlot = el('div', { className: 'synopsis-slot' });
  if (!inSet && r.description) synopsisSlot.append(buildSynopsis(r.description));

  const body = el('div', { className: 'card-body' }, [
    el('h3', {}, heroTitle),
    heroAuthor ? el('p', { className: 'author' }, heroAuthor) : null,
    badges,
    setNote,
    meta,
    synopsisSlot,
    dlRow,
    reupRow,
  ]);

  // For a set result, fetch the searched book's own cover + blurb and swap them
  // in once they arrive (fail-soft: keep the placeholder / set fallback).
  if (inSet) {
    const params = new URLSearchParams();
    if (r.matchedTitle) params.set('title', r.matchedTitle);
    if (heroAuthor) params.set('author', heroAuthor);
    fetch(`/api/meta?${params.toString()}`)
      .then((res) => res.json())
      .then((meta) => {
        renderCover(meta && meta.cover ? meta.cover : (r.cover || null));
        const blurb = (meta && meta.description) || r.description;
        if (blurb) { synopsisSlot.innerHTML = ''; synopsisSlot.append(buildSynopsis(blurb)); }
      })
      .catch(() => {
        renderCover(r.cover || null); // network hiccup → fall back to the set cover
        if (r.description) { synopsisSlot.innerHTML = ''; synopsisSlot.append(buildSynopsis(r.description)); }
      });
  }

  return el('div', { className: 'card' }, [cover, body]);
}

function renderCard(r) {
  (document.getElementById('resultsList') || resultsEl).append(buildCard(r));
}

// --- Library-first stage ----------------------------------------------------
// Every search checks your Library first (server emits a 'library' SSE step
// before the Mobilism scrape). When you already own the book, surface it ABOVE
// the live results so you can see — at a glance — that you have it and who it's
// been sent to. Cover + blurb come from the book catalog (/api/meta) when the
// stored record lacks them.
function renderLibraryHits(books) {
  if (!Array.isArray(books) || !books.length) return;
  resultsEl.querySelector('.library-hit')?.remove(); // replace any prior section
  const head = books.length === 1
    ? 'Already in your library'
    : `${books.length} already in your library`;
  const section = el('div', { className: 'library-hit' }, [
    el('div', { className: 'library-hit-head' }, [el('span', {}, '📚'), el('span', {}, head)]),
  ]);
  for (const b of books) section.append(buildLibraryHitCard(b));
  resultsEl.insertBefore(section, resultsEl.firstChild);
}

function buildLibraryHitCard(book) {
  // Mutable cover slot — a catalog lookup fills it in when the record has none.
  const cover = el('div', { className: 'cover-slot' });
  function renderCover(src, { loading = false } = {}) {
    cover.innerHTML = '';
    if (src) {
      const img = el('img', { className: 'cover zoomable', src, alt: 'cover', loading: 'lazy', title: 'Click to enlarge' });
      img.addEventListener('click', () => openLightbox(src, book.title));
      cover.append(img);
    } else {
      cover.append(el('div', { className: 'cover placeholder' + (loading ? ' loading' : ''), title: loading ? 'Looking up cover…' : 'No cover available' }, loading ? '' : '📖'));
    }
  }
  renderCover(book.cover || null, { loading: !book.cover });

  const badges = el('div', { className: 'badges' }, [
    el('span', { className: 'badge own' }, '📚 In your library'),
    el('span', { className: 'badge' }, book.mode === 'standard' ? 'External' : 'Premium'),
    book.verified ? el('span', { className: 'badge ok-badge' }, 'Verified ✓') : null,
  ]);

  const metaBits = [];
  if (book.size) metaBits.push(el('span', {}, `📦 ${formatBytes(book.size)}`));
  if (book.acquiredAt) metaBits.push(el('span', {}, `📅 ${formatDate(book.acquiredAt)}`));
  const meta = el('div', { className: 'meta' }, metaBits);

  // Send history — the "who's it gone to?" quick review the user wants.
  const sendsWrap = el('div', { className: 'lib-sends' });
  function renderSends() {
    sendsWrap.innerHTML = '';
    if (!book.sends || !book.sends.length) {
      sendsWrap.append(el('div', { className: 'lib-notsent' }, 'Not sent to anyone yet'));
      return;
    }
    const who = [...new Set(book.sends.flatMap((s) => s.to || []))].filter(Boolean).join(', ');
    sendsWrap.append(el('div', { className: 'lib-sends-head' }, who ? `Sent to ${who}` : `Sent ${book.sends.length}×`));
    for (const s of book.sends) sendsWrap.append(renderSend(s));
  }
  renderSends();

  const synopsisSlot = el('div', { className: 'synopsis-slot' });

  const actions = el('div', { className: 'dl-row' });
  if (book.filePresent) {
    const btn = el('button', { className: 'dl-btn premium', type: 'button' },
      book.sends && book.sends.length ? '📧 Resend' : '📧 Send to readers');
    btn.addEventListener('click', () => openSendModal({
      downloadId: book.id,
      book: { title: book.title, author: book.author || '', cover: book.cover || null, filename: book.filename },
      onSent: () => refreshHitSends(book, renderSends),
    }));
    actions.append(btn);
  } else {
    actions.append(el('span', { className: 'hint' }, '⚠ File removed from disk.'));
  }
  if (book.url) actions.append(el('a', { className: 'topic-link', href: book.url, target: '_blank', rel: 'noopener' }, 'View thread ↗'));

  const body = el('div', { className: 'card-body' }, [
    el('h3', {}, book.title || book.filename || 'Untitled'),
    book.author ? el('p', { className: 'author' }, book.author) : null,
    badges,
    meta,
    sendsWrap,
    synopsisSlot,
    actions,
  ]);

  // Catalog lookup: fill the cover (if missing) and always try for a blurb.
  const params = new URLSearchParams();
  if (book.title) params.set('title', book.title);
  if (book.author) params.set('author', book.author);
  if (params.toString()) {
    fetch(`/api/meta?${params.toString()}`)
      .then((r) => r.json())
      .then((meta) => {
        if (!book.cover) renderCover((meta && meta.cover) || null);
        if (meta && meta.description) { synopsisSlot.innerHTML = ''; synopsisSlot.append(buildSynopsis(meta.description)); }
      })
      .catch(() => { if (!book.cover) renderCover(null); });
  } else if (!book.cover) {
    renderCover(null);
  }

  return el('div', { className: 'card library-card' }, [cover, body]);
}

// After a send from a library-hit card, refresh just that book's send history.
async function refreshHitSends(book, renderSends) {
  try {
    const data = await fetch('/api/library').then((r) => r.json());
    const fresh = (data.books || []).find((b) => b.id === book.id);
    if (fresh) { book.sends = fresh.sends || []; renderSends(); }
  } catch { /* best effort — leave the existing list */ }
}

// Collapsible synopsis: clamp to a few lines with a more/less toggle when the
// blurb is long enough to be worth hiding.
function buildSynopsis(text) {
  const wrap = el('div', { className: 'synopsis' });
  const p = el('p', { className: 'synopsis-text clamped' }, text);
  wrap.append(p);
  if (String(text).length > 140) {
    const toggle = el('button', { className: 'synopsis-toggle', type: 'button' }, 'more');
    toggle.addEventListener('click', () => {
      const clamped = p.classList.toggle('clamped');
      toggle.textContent = clamped ? 'more' : 'less';
    });
    wrap.append(toggle);
  } else {
    p.classList.remove('clamped');
  }
  return wrap;
}

// --- Cover lightbox (click any cover to enlarge) ---------------------------
function openLightbox(src, alt) {
  let lb = $('#lightbox');
  if (!lb) {
    lb = el('div', { className: 'lightbox', id: 'lightbox' });
    lb.addEventListener('click', closeLightbox);
    document.body.append(lb);
  }
  lb.innerHTML = '';
  lb.append(el('img', { src, alt: alt || '' }));
  lb.hidden = false;
}
function closeLightbox() {
  const lb = $('#lightbox');
  if (lb) { lb.hidden = true; lb.innerHTML = ''; }
}

// ---------------------------------------------------------------------------
// Result view: filter + sort the fetched results in the browser (no re-scrape).
// Mirrors src/resultfilter.js (the unit-tested canonical spec).
// ---------------------------------------------------------------------------
let lastResults = [];
let resultView = { format: 'all', minMB: null, maxMB: null, sort: 'relevance' };
const UNIT_BYTES = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

function parseSizeToBytes(size) {
  if (typeof size !== 'string') return null;
  const m = size.trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)$/i);
  return m ? Math.round(parseFloat(m[1]) * UNIT_BYTES[m[2].toUpperCase()]) : null;
}
function isEpubResult(r) { return String((r && r.format) || '').toLowerCase() === 'epub'; }

function filterResults(results, opts) {
  const min = Number.isFinite(opts.minMB) ? opts.minMB * UNIT_BYTES.MB : null;
  const max = Number.isFinite(opts.maxMB) ? opts.maxMB * UNIT_BYTES.MB : null;
  return results.filter((r) => {
    if (opts.format === 'epub' && !isEpubResult(r)) return false;
    if (opts.format === 'other' && isEpubResult(r)) return false;
    const bytes = parseSizeToBytes(r && r.size);
    if (bytes != null) {
      if (min != null && bytes < min) return false;
      if (max != null && bytes > max) return false;
    }
    return true;
  });
}
function sortResults(results, sort) {
  const arr = results.map((r, i) => ({ r, i }));
  const dateMs = (r) => { const t = r.date ? Date.parse(r.date) : NaN; return Number.isNaN(t) ? null : t; };
  const cmp = (get, dir) => (a, b) => {
    const av = get(a.r); const bv = get(b.r);
    if (av == null && bv == null) return a.i - b.i;
    if (av == null) return 1;
    if (bv == null) return -1;
    return av === bv ? a.i - b.i : dir * (av - bv);
  };
  if (sort === 'newest') arr.sort(cmp(dateMs, -1));
  else if (sort === 'oldest') arr.sort(cmp(dateMs, 1));
  else if (sort === 'largest') arr.sort(cmp((r) => parseSizeToBytes(r.size), -1));
  else if (sort === 'smallest') arr.sort(cmp((r) => parseSizeToBytes(r.size), 1));
  return arr.map((x) => x.r);
}

function showResults(results) {
  lastResults = results.slice();
  resultView = { format: 'all', minMB: null, maxMB: null, sort: 'relevance' };
  resultsEl.querySelector('.results-bar')?.remove();
  resultsEl.querySelector('.results-list')?.remove();
  resultsEl.append(buildResultsBar(), el('div', { className: 'results-list', id: 'resultsList' }));
  applyResultView();
  // Cross-reference the library so the "In library" badge can light up; re-render
  // once it's known (fire-and-forget — never blocks showing results).
  refreshLibraryIndex().then(applyResultView).catch(() => {});
}

// A "Watch this search" button that saves the current query to the watchlist
// (issue #7) and confirms inline. Shown on the results bar AND the not-found
// state, so the user can ask to be emailed whether or not anything turned up
// (e.g. to hear about a fresh re-upload of a book that's currently stale).
function buildWatchSearchButton(labels = {}) {
  const idle = labels.idle || '🔔 Watch this search';
  const done = labels.done || '🔔 Watching — we’ll email you';
  const title = ((lastSearchParams && lastSearchParams.title) || $('#title').value || '').trim();
  const author = ((lastSearchParams && lastSearchParams.author) || $('#author').value || '').trim();
  const sort = (lastSearchParams && lastSearchParams.sort) || $('#sort').value || 'newest';
  const btn = el('button',
    { className: 'ghost-btn watch-cta', type: 'button',
      title: 'Get an email when a copy of this shows up on Mobilism' },
    idle);
  if (!title && !author) btn.disabled = true;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const res = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, author, sort }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not add watch');
      btn.textContent = done;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = `⚠ ${err.message}`;
    }
  });
  return btn;
}

function buildResultsBar() {
  const opt = (v, l) => el('option', { value: v }, l);
  const fmt = el('select', { className: 'rf-select', id: 'rfFormat' },
    [opt('all', 'All formats'), opt('epub', 'ePUB only'), opt('other', 'Other')]);
  fmt.addEventListener('change', () => { resultView.format = fmt.value; applyResultView(); });
  const sort = el('select', { className: 'rf-select', id: 'rfSort' },
    [opt('relevance', 'Best match'), opt('newest', 'Newest'), opt('oldest', 'Oldest'),
     opt('largest', 'Largest'), opt('smallest', 'Smallest')]);
  sort.addEventListener('change', () => { resultView.sort = sort.value; applyResultView(); });
  const min = el('input', { className: 'rf-size', id: 'rfMin', type: 'number', min: '0', placeholder: 'min' });
  const max = el('input', { className: 'rf-size', id: 'rfMax', type: 'number', min: '0', placeholder: 'max' });
  const onSize = () => {
    resultView.minMB = min.value !== '' ? Number(min.value) : null;
    resultView.maxMB = max.value !== '' ? Number(max.value) : null;
    applyResultView();
  };
  min.addEventListener('input', debounce(onSize, 200));
  max.addEventListener('input', debounce(onSize, 200));

  const ctrl = (label, ...nodes) => el('label', { className: 'rf-field' }, [el('span', { className: 'rf-label' }, label), ...nodes]);
  return el('div', { className: 'results-bar' }, [
    el('span', { className: 'results-count', id: 'resultsCount' }, ''),
    el('div', { className: 'results-controls' }, [
      ctrl('Format', fmt),
      ctrl('Sort', sort),
      ctrl('Size (MB)', el('span', { className: 'rf-size-pair' }, [min, el('span', { className: 'rf-dash' }, '–'), max])),
      // Offer to watch the same search even when results are showing.
      el('div', { className: 'rf-field rf-watch' }, [buildWatchSearchButton()]),
    ]),
  ]);
}

function applyResultView() {
  const list = $('#resultsList');
  if (!list) return;
  const view = sortResults(filterResults(lastResults, resultView), resultView.sort);
  list.innerHTML = '';
  if (!view.length) {
    list.append(el('p', { className: 'hint results-none' }, 'No results match the current filters.'));
  } else {
    for (const r of view) list.append(buildCard(r));
  }
  const cnt = $('#resultsCount');
  if (cnt) cnt.textContent = view.length === lastResults.length
    ? `${lastResults.length} result${lastResults.length === 1 ? '' : 's'}`
    : `${view.length} of ${lastResults.length}`;
}

// --- "Already in your library" index ---------------------------------------
// Soft match: same normalized title, and authors agree (or one is unknown).
let libraryIndex = [];
function libNorm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
async function refreshLibraryIndex() {
  try {
    const data = await fetch('/api/library').then((r) => r.json());
    libraryIndex = (data.books || []).map((b) => ({ t: libNorm(b.title), a: libNorm(b.author) }));
  } catch { /* leave the previous index */ }
}
function isInLibrary(r) {
  const t = libNorm(r.title);
  if (!t) return false;
  const a = libNorm(r.author);
  return libraryIndex.some((b) => b.t === t && (!a || !b.a || b.a === a));
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

function renderNotFound(links, externalSources) {
  const linkBits = [];
  if (links?.title) linkBits.push(el('a', { href: links.title, target: '_blank', rel: 'noopener' }, 'Open title search on Mobilism ↗'));
  if (links?.author) linkBits.push(el('a', { href: links.author, target: '_blank', rel: 'noopener' }, 'Open author search on Mobilism ↗'));
  statusEl.hidden = false;
  statusEl.className = 'status';
  statusEl.innerHTML = '<strong>Not found.</strong> No ePUB matches turned up. Try the manual searches:';
  statusEl.append(el('div', { className: 'links' }, linkBits));

  // Fallback to other sources (issue #19) — link-out only, opens a new tab.
  if (Array.isArray(externalSources) && externalSources.length) {
    const otherBits = externalSources.map((s) =>
      el('a', { href: s.url, target: '_blank', rel: 'noopener' }, `${s.name} ↗`)
    );
    statusEl.append(el('p', { className: 'hint', style: 'margin:0.6rem 0 0' }, 'Or search another source:'));
    statusEl.append(el('div', { className: 'links' }, otherBits));
  }

  // Watch this search (issue #7) — get pinged when it finally shows up.
  if (($('#title').value || '').trim() || ($('#author').value || '').trim()) {
    statusEl.append(
      el('div', { className: 'links', style: 'margin-top:0.7rem' }, [
        buildWatchSearchButton({ idle: '🔔 Watch for this book' }),
      ])
    );
  }
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
  { id: 'extract', label: 'Unpack the archive (if any)' },
  { id: 'verify', label: "Open the ePUB & confirm it's the right book" },
  { id: 'thank', label: 'Give thanks to the poster' },
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
      body: JSON.stringify({
        url: result.url,
        title: result.title,
        searchedTitle: $('#title').value.trim(),
        author: result.author || '',
        cover: result.cover || null,
      }),
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

// Tracks whether the current mirror produced an archive, so the "Unpack" step
// can resolve to "not an archive" instead of hanging when a bare ePUB arrives.
let dlArchiveSeen = false;

function handleDownloadEvent(ev, result) {
  switch (ev.step) {
    case 'reading-post':
      setStep('read', 'active');
      break;
    case 'mirrors-found':
      setStep('read', 'done', `Found ${ev.total} mirror${ev.total === 1 ? '' : 's'}`);
      break;
    case 'mirror':
      // A new mirror attempt begins — reset the per-mirror steps. Sign-in is the
      // next thing that happens, so IT (not Download) becomes the active step;
      // Download stays pending but carries the "Mirror X of Y" context. The
      // 'downloading' event then flips Sign-in → done and Download → active, so
      // the spinner never jumps ahead to step 3 before step 2 has run.
      stopFetchTimer();
      dlArchiveSeen = false;
      setStep('login', 'active', '');
      setStep('fetch', 'pending', `Mirror ${ev.index} of ${ev.total}${ev.host ? ' · ' + ev.host : ''}`);
      setStep('extract', 'pending', '');
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
    case 'extracting':
      dlArchiveSeen = true;
      setStep('extract', 'active', `Unpacking the ${(ev.archive || 'archive').toUpperCase()}…`);
      break;
    case 'extracted':
      setStep('extract', 'done', ev.count > 1 ? `Picked the ePUB from ${ev.count} in the archive` : 'Found the ePUB inside');
      break;
    case 'verifying':
      if (!dlArchiveSeen) setStep('extract', 'done', 'Not an archive — direct ePUB');
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
    case 'mirror-mismatch':
      // A file was saved but failed verification — the server is moving on to
      // the next mirror, so show why rather than leaving the ✓/⚠ ambiguous.
      stopFetchTimer();
      setStep('verify', 'warn', ev.verified
        ? `Got “${ev.embeddedTitle || '?'}” — wrong book, trying the next mirror…`
        : 'File failed the ePUB check — trying the next mirror…');
      break;
    // Giving Thanks (issue #25) — best-effort, never a hard failure.
    case 'thanking':
      setStep('thank', 'active', 'Clicking “Thank You”…');
      break;
    case 'thanked':
      setStep('thank', 'done', ev.reason || 'Thanked the poster 🙏');
      break;
    case 'thanks-skipped':
      setStep('thank', 'done', ev.reason || 'Already thanked');
      break;
    case 'thanks-failed':
      // Non-blocking: show as a soft warning, not a download failure.
      setStep('thank', 'warn', ev.reason || 'Couldn’t thank the poster');
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
    // Nothing downloaded — explain why in plain language.
    $('#dlHeading').textContent = 'Download failed';
    $('#dlHeading').className = 'dl-fail-head';
    const errs = data.errors || [];
    if (errs.length === 1) {
      // One mirror → lead with its (already human-readable) reason.
      box.append(el('div', { className: 'dl-check warn' }, errs[0].error));
    } else if (errs.length) {
      box.append(el('p', { className: 'hint' }, 'None of the mirrors returned a valid book file:'));
      const ul = el('ul', { className: 'dl-errors' }, errs.map((e) => el('li', {}, `✕ ${e.error}`)));
      box.append(ul);
    } else {
      box.append(el('div', { className: 'dl-check warn' }, 'Couldn’t download this book — no mirror returned a file.'));
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
  // On-brand confetti: BookHunt orange + navy, warmed with gold and cream.
  const colors = ['#f1592a', '#1c2a56', '#ffb347', '#f6f1e7', '#ff8157'];
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

function logStandard(link, title, author, cover) {
  fetch('/api/download/standard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: link.url, host: link.host, title, author: author || '', cover: cover || null }),
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
  if (settingsModal && !settingsModal.hidden) loadSettings();
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
  await loadGroups();
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
    // Name only — the email/Kindle addresses are managed elsewhere and don't
    // need to be shown here. The 📖 still flags that a Kindle push will happen.
    const tag = r.kindleEmail ? ' 📖' : '';
    list.append(el('label', { className: 'recip-row', htmlFor: id }, [cb, ` ${r.name}${tag}`]));
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
    // Reader portal (issue #34): invite (emails their magic link), rotate the
    // link if it leaks, and toggle their new-book emails.
    const status = el('span', { className: 'hint recip-reader-status' },
      r.readerToken ? (r.readerEnabled === false ? '🔕 shelf on, emails off' : '📖 shelf reader') : '');
    const invite = el('button', { className: 'ghost-btn', type: 'button',
      title: 'Email them their personal shelf link' }, r.readerToken ? '✉ Re-invite' : '✉ Invite');
    invite.addEventListener('click', async () => {
      invite.disabled = true;
      invite.textContent = 'Sending…';
      try {
        const res = await fetch('/api/recipients/' + r.id + '/invite', { method: 'POST' });
        const out = await res.json();
        if (!res.ok) throw new Error(out.error || 'Invite failed');
        invite.textContent = '✓ Invited';
        await loadRecipients();
      } catch (e) {
        invite.disabled = false;
        invite.textContent = '✕ ' + (e.message || 'Failed');
      }
    });
    const rotate = r.readerToken
      ? el('button', { className: 'ghost-btn', type: 'button',
          title: 'New link — the old one stops working (use if a link leaks)' }, '♻')
      : null;
    if (rotate) rotate.addEventListener('click', async () => {
      if (!window.confirm(`Give ${r.name} a new shelf link? Their old link stops working until you re-invite them.`)) return;
      await fetch('/api/recipients/' + r.id + '/reader-token', { method: 'POST' });
      await loadRecipients();
    });
    ml.append(
      el('div', { className: 'manage-row' }, [
        el('span', {}, [`${r.name} · ${r.email}${r.kindleEmail ? ' · ' + r.kindleEmail : ''} `, status]),
        el('span', { className: 'manage-actions' }, [invite, rotate, del]),
      ])
    );
  }
}

// A single recipient's send counts as OK when nothing hard-failed: the Kindle
// push is absent/ok/skipped AND every channel is ok or skipped. Shared by the
// result rendering and the auto-close decision (issue #31).
function sendResultOk(r) {
  return (!r.kindle || r.kindle.ok || r.kindle.skipped) && r.channels.every((c) => c.ok || c.skipped);
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
    const ok = sendResultOk(r);
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
  let sentClean = false;
  try {
    // One book (downloadId) or several (downloadIds, from a Library multi-select).
    const targets = sendCtx.downloadIds && sendCtx.downloadIds.length ? sendCtx.downloadIds : [sendCtx.downloadId];
    const all = [];
    for (const downloadId of targets) {
      const res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ downloadId, recipientIds: ids, book: sendCtx.book }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Send failed');
      all.push(...data.results);
    }
    renderSendResults(all);
    // Let an opener (e.g. the Library view) refresh its inline send history.
    if (sendCtx && typeof sendCtx.onSent === 'function') sendCtx.onSent();
    // On a clean send (every recipient OK), dismiss the send modal and the
    // download-steps modal behind it so the user lands back without manual
    // cleanup (issue #31). On any failure, leave the modal open with the result
    // visible so they can see what went wrong and retry.
    if (all.length && all.every(sendResultOk)) {
      sentClean = true;
      go.textContent = 'Sent ✓';
      setTimeout(() => { closeSendModal(); closeDownloadModal(); go.textContent = 'Send'; }, 900);
    }
  } catch (err) {
    box.innerHTML = '';
    box.append(el('div', { className: 'dl-result err' }, err.message));
  } finally {
    go.disabled = false;
    // Keep the "Sent ✓" confirmation visible until the auto-close fires; only
    // restore the default label when the send didn't fully succeed.
    if (!sentClean) go.textContent = 'Send';
  }
});

// ---------------------------------------------------------------------------
// Recipient groups (presets) — pick a whole audience in one click
// ---------------------------------------------------------------------------
let groupsCache = [];
const groupBar = $('#groupBar');

async function loadGroups() {
  try {
    const data = await fetch('/api/recipient-groups').then((r) => r.json());
    groupsCache = data.groups || [];
  } catch {
    groupsCache = [];
  }
  renderGroupBar();
  renderGroupManageList();
}

function renderGroupBar() {
  groupBar.innerHTML = '';
  if (!groupsCache.length) { groupBar.hidden = true; return; }
  groupBar.hidden = false;
  groupBar.append(el('span', { className: 'group-bar-label' }, 'Groups'));
  for (const g of groupsCache) {
    const chip = el('button', { className: 'group-chip', type: 'button' }, `${g.name} · ${g.recipientIds.length}`);
    chip.addEventListener('click', () => selectGroup(g));
    groupBar.append(chip);
  }
}

// Check exactly the members of a group (uncheck everyone else).
function selectGroup(g) {
  const ids = new Set(g.recipientIds);
  for (const r of recipientsCache) {
    const cb = $('#rc_' + r.id);
    if (cb) cb.checked = ids.has(r.id);
  }
}

function renderGroupManageList() {
  const ml = $('#groupManageList');
  if (!ml) return;
  ml.innerHTML = '';
  if (!groupsCache.length) {
    ml.append(el('p', { className: 'hint' }, 'No groups yet.'));
    return;
  }
  for (const g of groupsCache) {
    const del = el('button', { className: 'ghost-btn', type: 'button' }, 'Delete');
    del.addEventListener('click', async () => {
      await fetch('/api/recipient-groups/' + g.id, { method: 'DELETE' });
      await loadGroups();
    });
    ml.append(el('div', { className: 'manage-row' }, [
      el('span', {}, `${g.name} · ${g.recipientIds.length} recipient${g.recipientIds.length === 1 ? '' : 's'}`),
      del,
    ]));
  }
}

$('#groupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#groupName').value.trim();
  const recipientIds = recipientsCache.filter((r) => $('#rc_' + r.id) && $('#rc_' + r.id).checked).map((r) => r.id);
  if (!name) { alert('Name the group first.'); return; }
  if (!recipientIds.length) { alert('Check the recipients to include, then save the group.'); return; }
  const res = await fetch('/api/recipient-groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, recipientIds }),
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Could not save group'); return; }
  $('#groupName').value = '';
  await loadGroups();
});

// ---------------------------------------------------------------------------
// Settings — premium creds, notification channels, test email
// ---------------------------------------------------------------------------
const settingsModal = $('#settingsModal');
$('#settingsToggle').addEventListener('click', openSettings);
$('#settingsClose').addEventListener('click', closeSettings);
$('#setPremUpdate').addEventListener('click', () => openCredModal());
$('#setTestBtn').addEventListener('click', sendTestEmail);
$('#setWatchCadence').addEventListener('change', saveWatchCadence);
$('#setListsEnabled').addEventListener('change', saveListsSettings);
$('#setListCadence').addEventListener('change', saveListsSettings);
$('#setListsRun').addEventListener('click', runListsNow);

// Reflect the saved cadence in the dropdown; add a one-off option if the stored
// value isn't one of the presets (e.g. an env-set custom value).
function setWatchCadenceSelect(minutes) {
  const sel = $('#setWatchCadence');
  if (!sel) return;
  const v = String(minutes);
  if (![...sel.options].some((o) => o.value === v)) {
    sel.append(el('option', { value: v }, `${minutes} minutes`));
  }
  sel.value = v;
}

async function saveWatchCadence() {
  const sel = $('#setWatchCadence');
  const out = $('#setWatchResult');
  out.className = 'set-test-result';
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watchCheckIntervalMin: Number(sel.value) }),
    });
    if (!res.ok) throw new Error('Could not save');
    out.classList.add('ok');
    out.textContent = '✓ Saved — takes effect on the next check.';
  } catch {
    out.classList.add('err');
    out.textContent = 'Could not save the cadence.';
  }
}

function closeSettings() { settingsModal.hidden = true; }
async function openSettings() {
  settingsModal.hidden = false;
  $('#setTestResult').textContent = '';
  $('#setTestResult').className = 'set-test-result';
  await loadSettings();
}

async function loadSettings() {
  try {
    const s = await fetch('/api/status').then((r) => r.json());
    $('#setPremStatus').textContent = s.premium && s.premium.hasCreds
      ? '✓ Credentials are set for this session.'
      : 'No credentials set yet — required for premium downloads.';
    const box = $('#setChannels');
    box.innerHTML = '';
    for (const c of (s.channels || [])) {
      box.append(el('div', { className: 'set-channel ' + (c.configured ? 'on' : 'off') },
        `${c.configured ? '✓' : '✕'} ${c.label}${c.configured ? '' : ' — not configured'}`));
    }
    box.append(el('div', { className: 'set-channel ' + (s.kindle ? 'on' : 'off') },
      `${s.kindle ? '✓' : '✕'} Send-to-Kindle${s.kindle ? '' : ' — needs SMTP'}`));
    setWatchCadenceSelect((s.settings && s.settings.watchCheckIntervalMin) || 30);
    renderListsSettings(s);
    renderVersion(s.version);
  } catch {
    $('#setPremStatus').textContent = 'Could not load settings.';
    $('#setVersion').textContent = 'Unknown';
  }
}

// --- New-release radar settings (issue #33) ---------------------------------
function renderListsSettings(s) {
  const enabled = $('#setListsEnabled');
  const cadence = $('#setListCadence');
  const status = $('#setListsStatus');
  if (!enabled) return;
  const conf = s.lists && s.lists.configured;
  enabled.checked = !!(s.settings && s.settings.listsEnabled);
  enabled.disabled = !conf;
  cadence.disabled = !conf;
  $('#setListsRun').disabled = !conf || !enabled.checked;
  const hours = String((s.settings && s.settings.listPullIntervalHours) || 24);
  if (![...cadence.options].some((o) => o.value === hours)) {
    cadence.append(el('option', { value: hours }, `${hours} hours`));
  }
  cadence.value = hours;
  if (!conf) {
    status.textContent = 'Needs NYT_API_KEY in .env.';
  } else if (s.lists && s.lists.lastRunAt) {
    const watching = s.lists.watching || 0;
    status.textContent = `Last checked ${new Date(s.lists.lastRunAt).toLocaleString()}${watching ? ` · watching ${watching}` : ''}`;
  } else {
    status.textContent = 'Not run yet.';
  }
}

async function saveListsSettings() {
  const out = $('#setListsResult');
  out.className = 'set-test-result';
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        listsEnabled: $('#setListsEnabled').checked,
        listPullIntervalHours: Number($('#setListCadence').value),
      }),
    });
    if (!res.ok) throw new Error('Could not save');
    $('#setListsRun').disabled = !$('#setListsEnabled').checked;
    out.classList.add('ok');
    out.textContent = '✓ Saved.';
  } catch {
    out.classList.add('err');
    out.textContent = 'Could not save.';
  }
}

async function runListsNow() {
  const btn = $('#setListsRun');
  const out = $('#setListsResult');
  out.className = 'set-test-result';
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Checking…';
  try {
    const res = await fetch('/api/lists/run', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Run failed');
    if (data.skipped) {
      out.classList.add('err');
      out.textContent = `Skipped: ${data.skipped}`;
    } else {
      const bits = [];
      if ((data.seeded || []).length) bits.push('baseline saved — new entrants tracked from next refresh');
      if ((data.watching || []).length) bits.push(`now watching ${data.watching.length}`);
      if ((data.owned || []).length) bits.push(`${data.owned.length} already in your library`);
      if ((data.expired || []).length) bits.push(`${data.expired.length} expired`);
      if ((data.errors || []).length) bits.push(`${data.errors.length} error(s)`);
      out.classList.add('ok');
      out.textContent = '✓ ' + (bits.length ? bits.join(' · ') : 'Lists unchanged — nothing new.');
    }
    await loadSettings();
  } catch (err) {
    out.classList.add('err');
    out.textContent = err.message || 'Run failed.';
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// Show the running build: version (from package.json) + the commit & build time
// baked into the Docker image (blank when run outside the stamped image).
function renderVersion(v) {
  const box = $('#setVersion');
  if (!box) return;
  box.innerHTML = '';
  v = v || {};
  box.append(el('div', { className: 'set-version-line' }, [
    el('span', { className: 'set-version-num' }, `v${v.version || '?'}`),
    v.commit ? el('span', { className: 'set-version-meta' }, ` · ${v.commit}`) : null,
  ]));
  if (v.builtAt) {
    const when = new Date(v.builtAt);
    const built = isNaN(when) ? v.builtAt : when.toLocaleString();
    box.append(el('div', { className: 'set-version-built hint' }, `Built ${built}`));
  }
}

async function sendTestEmail() {
  const email = $('#setTestEmail').value.trim();
  const out = $('#setTestResult');
  out.className = 'set-test-result';
  if (!email) { out.classList.add('err'); out.textContent = 'Enter an email address.'; return; }
  const btn = $('#setTestBtn');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Sending…';
  try {
    const res = await fetch('/api/notify/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Send failed');
    out.classList.add('ok');
    out.textContent = '✓ Sent — check that inbox.';
  } catch (err) {
    out.classList.add('err');
    out.textContent = '✕ ' + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ---------------------------------------------------------------------------
// Status / health — session warmth, downloads, channels
// ---------------------------------------------------------------------------
const statusModal = $('#statusModal');
$('#statusToggle').addEventListener('click', openStatus);
$('#statusClose').addEventListener('click', closeStatus);
$('#statusRefresh').addEventListener('click', loadStatus);

function closeStatus() { statusModal.hidden = true; }
async function openStatus() { statusModal.hidden = false; await loadStatus(); }

function statusItem(label, value, ok) {
  const cls = 'status-item' + (ok === true ? ' ok' : ok === false ? ' warn' : '');
  return el('div', { className: cls }, [
    el('span', { className: 'status-k' }, label),
    el('span', { className: 'status-v' }, value),
  ]);
}

async function loadStatus() {
  const body = $('#statusBody');
  body.innerHTML = '<p class="hint">Loading…</p>';
  try {
    const s = await fetch('/api/status').then((r) => r.json());
    body.innerHTML = '';

    const sess = el('div', { className: 'status-section' }, [el('h3', {}, 'Mobilism session')]);
    if (!s.session.browser) {
      sess.append(statusItem('Browser', 'Not started', false));
    } else {
      sess.append(statusItem('Logged in', s.session.loggedIn ? 'Yes' : 'No', s.session.loggedIn));
      sess.append(statusItem('Cloudflare clearance', s.session.cfOk ? 'OK' : 'Missing/expired', s.session.cfOk));
      sess.append(statusItem('Ready to search', s.session.ready ? 'Yes' : 'No — re-warm', s.session.ready));
      if (!s.session.ready) {
        sess.append(el('a', { className: 'warm-btn', href: '/warm', target: '_blank', rel: 'noopener' }, 'Re-warm ↗'));
      }
    }
    body.append(sess);

    const d = s.download || {};
    const dl = el('div', { className: 'status-section' }, [el('h3', {}, 'Downloads')]);
    dl.append(statusItem('Folder', d.path || '—'));
    dl.append(statusItem('ePUBs saved', String(d.count || 0)));
    dl.append(statusItem('Total size', formatBytes(d.totalBytes || 0) || '0 B'));
    if (d.disk) dl.append(statusItem('Disk free', `${formatBytes(d.disk.freeBytes)} of ${formatBytes(d.disk.totalBytes)}`));
    if (!d.exists) dl.append(statusItem('Folder', 'Not created yet', false));
    body.append(dl);

    const ch = el('div', { className: 'status-section' }, [el('h3', {}, 'Channels & credentials')]);
    for (const c of (s.channels || [])) ch.append(statusItem(c.label, c.configured ? 'Configured' : 'Not configured', c.configured));
    ch.append(statusItem('Send-to-Kindle', s.kindle ? 'Configured' : 'Needs SMTP', s.kindle));
    ch.append(statusItem('Premium creds', s.premium && s.premium.hasCreds ? 'Set' : 'Not set', s.premium && s.premium.hasCreds));
    body.append(ch);
  } catch {
    body.innerHTML = '';
    body.append(el('p', { className: 'hint' }, 'Could not load status.'));
  }
}

// ---------------------------------------------------------------------------
// Library — every downloaded book with its send history inline + resend
// ---------------------------------------------------------------------------
const libraryPanel = $('#libraryPanel');
const libraryList = $('#libraryList');
const librarySearch = $('#librarySearch');
const libraryCount = $('#libraryCount');
$('#libraryToggle').addEventListener('click', openLibrary);
$('#libraryClose').addEventListener('click', closeLibrary);
// Live title/author filter — debounced so each keystroke doesn't thrash the DOM.
librarySearch.addEventListener('input', debounce(applyLibraryFilter, 120));

// List vs. cover-grid view (persisted). Grid is a pleasant cover-wall for
// browsing by spine; list keeps the full per-book detail + send history.
let libViewMode = localStorage.getItem('libView') === 'grid' ? 'grid' : 'list';
function setLibView(mode) {
  libViewMode = mode === 'grid' ? 'grid' : 'list';
  localStorage.setItem('libView', libViewMode);
  $('#libViewList').classList.toggle('active', libViewMode === 'list');
  $('#libViewGrid').classList.toggle('active', libViewMode === 'grid');
  applyLibraryFilter(); // re-render in the chosen mode
}
$('#libViewList').addEventListener('click', () => setLibView('list'));
$('#libViewGrid').addEventListener('click', () => setLibView('grid'));
$('#libViewList').classList.toggle('active', libViewMode === 'list');
$('#libViewGrid').classList.toggle('active', libViewMode === 'grid');

// Full set from the last /api/library load; the search box filters this in place
// (no refetch). Covers resolved lazily are remembered across re-filters.
let allLibraryBooks = [];
const coverCache = new Map(); // 'title|author' (lowercased) -> url | null

// The cover the Library currently shows for a book (lazily resolved, same key
// the row used), so a resend can hand the email the exact right artwork.
function resolvedLibraryCover(book) {
  const key = `${book.title || ''}|${book.author || ''}`.toLowerCase();
  return coverCache.get(key) || null;
}

async function openLibrary() {
  libraryPanel.hidden = false;
  $('#overlay').hidden = false;
  renderLibrarySkeleton();
  try {
    const data = await fetch('/api/library').then((r) => r.json());
    allLibraryBooks = data.books || [];
    libraryAllTags = data.allTags || [];
    libraryTagFilter = '';
    librarySelection.clear();
    librarySearch.value = '';
    renderLibTagBar();
    updateLibActionBar();
    applyLibraryFilter();
  } catch {
    allLibraryBooks = [];
    libraryCount.textContent = '';
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
  librarySelection.clear();
  updateLibActionBar();
}

// Filter the loaded library by the search box (matches title, author, filename),
// then render. Empty query shows everything.
function applyLibraryFilter() {
  const q = (librarySearch.value || '').trim().toLowerCase();
  let matches = !q
    ? allLibraryBooks
    : allLibraryBooks.filter((b) => {
        const hay = [b.title, b.author, b.filename].filter(Boolean).join(' ').toLowerCase();
        return q.split(/\s+/).every((term) => hay.includes(term));
      });
  if (libraryTagFilter) matches = matches.filter((b) => (b.tags || []).includes(libraryTagFilter));
  libraryCount.textContent = allLibraryBooks.length
    ? `${matches.length} of ${allLibraryBooks.length}`
    : '';
  renderLibrary(matches, q);
}

// --- Library management: tag filter, multi-select, delete, re-download ------
let libraryAllTags = [];
let libraryTagFilter = '';
const librarySelection = new Set();

function renderLibTagBar() {
  const bar = $('#libTagBar');
  if (!bar) return;
  bar.innerHTML = '';
  if (!libraryAllTags.length) { bar.hidden = true; return; }
  bar.hidden = false;
  const chip = (label, val) => {
    const c = el('button', { className: 'lib-tag-chip' + (libraryTagFilter === val ? ' active' : ''), type: 'button' }, label);
    c.addEventListener('click', () => {
      libraryTagFilter = libraryTagFilter === val ? '' : val;
      renderLibTagBar();
      applyLibraryFilter();
    });
    return c;
  };
  bar.append(chip('All', ''));
  for (const t of libraryAllTags) bar.append(chip(t, t));
}

function updateLibActionBar() {
  const bar = $('#libActionBar');
  if (!bar) return;
  const n = librarySelection.size;
  bar.innerHTML = '';
  if (!n) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.append(el('span', { className: 'lib-sel-count' }, `${n} selected`));
  const sendBtn = el('button', { className: 'primary-btn', type: 'button' }, '📧 Send');
  sendBtn.addEventListener('click', sendSelectedLibrary);
  const delBtn = el('button', { className: 'ghost-btn lib-del-btn', type: 'button' }, '🗑 Delete');
  delBtn.addEventListener('click', deleteSelectedLibrary);
  bar.append(sendBtn, delBtn);
}

function sendSelectedLibrary() {
  const ids = [...librarySelection];
  if (!ids.length) return;
  openSendModal({
    downloadIds: ids,
    book: { title: `${ids.length} selected book${ids.length === 1 ? '' : 's'}` },
    onSent: openLibrary,
  });
}

async function deleteSelectedLibrary() {
  const ids = [...librarySelection];
  if (!ids.length) return;
  if (!window.confirm(`Delete ${ids.length} book${ids.length === 1 ? '' : 's'}? This removes the file from disk and clears its send history.`)) return;
  for (const id of ids) {
    try { await fetch('/api/library/' + id, { method: 'DELETE' }); } catch { /* keep going */ }
  }
  librarySelection.clear();
  await openLibrary();
}

// Per-book removal — same endpoint as the multi-select Delete, minus the
// selection dance. Removes the file from disk and the book's send history.
async function deleteLibraryBook(book) {
  const name = book.title || book.filename || 'this book';
  if (!window.confirm(`Delete “${name}”? This removes the file from disk and clears its send history.`)) return;
  try { await fetch('/api/library/' + book.id, { method: 'DELETE' }); } catch { /* best effort */ }
  librarySelection.delete(book.id);
  await openLibrary();
}

async function editBookTags(book) {
  const input = window.prompt('Tags for this book (comma-separated):', (book.tags || []).join(', '));
  if (input === null) return;
  const tags = input.split(',').map((s) => s.trim()).filter(Boolean);
  try {
    await fetch('/api/library/' + book.id + '/tags', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags }),
    });
  } catch { /* best effort */ }
  await openLibrary();
}

function redownloadBook(book) {
  closeLibrary();
  premiumDownload({ url: book.url, title: book.title, author: book.author || '', cover: book.cover || null }, null);
}

// Lazy cover loading: only fetch a cover once its row scrolls into view. One
// observer drives every placeholder; each carries its title/author on dataset.
const coverObserver = ('IntersectionObserver' in window)
  ? new IntersectionObserver((entries, obs) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          obs.unobserve(entry.target);
          loadCover(entry.target);
        }
      }
    }, { root: libraryList, rootMargin: '200px' })
  : null;

async function loadCover(holder) {
  const title = holder.dataset.title || '';
  const author = holder.dataset.author || '';
  const key = `${title}|${author}`.toLowerCase();

  let url = coverCache.get(key);
  if (url === undefined) {
    try {
      const params = new URLSearchParams();
      if (title) params.set('title', title);
      if (author) params.set('author', author);
      const data = await fetch(`/api/cover?${params.toString()}`).then((r) => r.json());
      url = data.cover || null;
    } catch {
      url = null;
    }
    coverCache.set(key, url);
  }
  // The holder may have been re-rendered away by a filter change; only paint if
  // it's still in the DOM. Swap the placeholder div for a real cover <img> so it
  // gets the same sizing as a stored cover (the div had centering styles that
  // would otherwise let a natural-size image overflow the row).
  if (url && holder.isConnected) {
    const img = el('img', { className: 'lib-cover', src: url, alt: '', loading: 'lazy' });
    img.addEventListener('error', () => img.replaceWith(makeCoverPlaceholder()));
    holder.replaceWith(img);
  }
}

// A book-emoji placeholder sized exactly like a real cover.
function makeCoverPlaceholder() {
  return el('div', { className: 'lib-cover placeholder' }, '📖');
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

function renderLibrary(books, query) {
  libraryList.innerHTML = '';
  libraryList.classList.toggle('lib-grid', libViewMode === 'grid');
  if (!books.length) {
    const empty = query
      ? el('div', { className: 'lib-empty' }, [
          el('div', { className: 'lib-empty-icon' }, '🔍'),
          el('p', {}, 'No matches.'),
          el('p', { className: 'hint' }, `Nothing in your library matches “${query}”.`),
        ])
      : el('div', { className: 'lib-empty' }, [
          el('div', { className: 'lib-empty-icon' }, '📭'),
          el('p', {}, 'No books yet.'),
          el('p', { className: 'hint' }, 'Download a book and it’ll show up here with its send history.'),
        ]);
    libraryList.append(empty);
    return;
  }
  const render = libViewMode === 'grid' ? renderLibraryGridCard : renderLibraryBook;
  books.forEach((book, i) => {
    const node = render(book);
    node.style.setProperty('--i', i); // staggered reveal
    libraryList.append(node);
  });
}

// A cover-forward grid tile: the artwork is the hero, with a soft caption and a
// tap-to-enlarge cover. A "sent" pip shows at a glance which books have gone out;
// the ✎ overlay (from buildEditableCover) still lets a wrong cover be fixed.
function renderLibraryGridCard(book) {
  const select = el('input', { type: 'checkbox', className: 'lib-select lib-tile-select',
    'aria-label': `Select ${book.title || book.filename}` });
  select.checked = librarySelection.has(book.id);
  select.addEventListener('change', () => {
    if (select.checked) librarySelection.add(book.id); else librarySelection.delete(book.id);
    tile.classList.toggle('selected', select.checked);
    updateLibActionBar();
  });

  const sentCount = (book.sends && book.sends.length) || 0;
  const pip = sentCount
    ? el('span', { className: 'lib-tile-pip sent', title: `Sent ${sentCount}×` }, '✓')
    : el('span', { className: 'lib-tile-pip', title: 'Not sent yet' }, '·');

  const send = el('button', { className: 'lib-tile-send', type: 'button',
    title: sentCount ? 'Resend' : 'Send to readers' }, '📧');
  send.disabled = !book.filePresent;
  send.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!book.filePresent) return;
    openSendModal({
      downloadId: book.id,
      book: { title: book.title, author: book.author || '', cover: book.cover || resolvedLibraryCover(book) || null, filename: book.filename },
      onSent: openLibrary,
    });
  });

  const del = el('button', { className: 'lib-tile-del', type: 'button', title: 'Remove from library' }, '🗑');
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteLibraryBook(book);
  });

  const tile = el('div', { className: 'lib-tile' + (select.checked ? ' selected' : '') }, [
    el('div', { className: 'lib-tile-art' }, [buildEditableCover(book), pip, select, send, del]),
    el('div', { className: 'lib-tile-info' }, [
      el('div', { className: 'lib-tile-title', title: book.title || book.filename || '' }, book.title || book.filename || 'Untitled'),
      book.author ? el('div', { className: 'lib-tile-author', title: book.author }, book.author) : null,
    ]),
  ]);
  return tile;
}

// Build a book's cover element. A stored cover renders immediately; otherwise a
// placeholder is returned and registered with the IntersectionObserver so its
// cover is fetched only once it scrolls into view (lazy loading).
function renderLibraryCover(book) {
  const key = `${book.title || ''}|${book.author || ''}`.toLowerCase();
  const cached = book.cover || coverCache.get(key);
  if (cached) {
    const img = el('img', { className: 'lib-cover', src: cached, alt: '', loading: 'lazy' });
    img.addEventListener('error', () => img.replaceWith(makeCoverPlaceholder()));
    return img;
  }
  const holder = makeCoverPlaceholder();
  holder.dataset.title = book.title || '';
  holder.dataset.author = book.author || '';
  if (coverObserver) coverObserver.observe(holder);
  else loadCover(holder); // no IO support → just fetch now
  return holder;
}

function renderLibraryBook(book) {
  const sendCount = (book.sends && book.sends.length) || 0;

  // One merged metaline: format/verified pills, size, date, missing-file chip,
  // then tag pills. No 📦/📅 emoji — the values speak for themselves.
  const metaline = el('div', { className: 'lib-metaline' }, [
    el('span', { className: 'badge' }, (book.mode === 'standard' ? 'External' : 'Premium')),
    book.verified ? el('span', { className: 'badge ok-badge' }, 'Verified ✓') : null,
    book.size ? el('span', { className: 'lib-meta-bit' }, formatBytes(book.size)) : null,
    book.acquiredAt ? el('span', { className: 'lib-meta-bit' }, formatDate(book.acquiredAt)) : null,
    !book.filePresent ? el('span', { className: 'lib-warn-chip' }, '⚠ File removed') : null,
    ...(book.tags || []).map((t) => el('span', { className: 'lib-tag' }, t)),
  ]);

  // Full send history — lives in the drawer, collapsed by default.
  const sendsWrap = el('div', { className: 'lib-sends' });
  if (!sendCount) {
    sendsWrap.append(el('div', { className: 'lib-notsent' }, 'Not sent yet'));
  } else {
    sendsWrap.append(el('div', { className: 'lib-sends-head' }, `Sent ${sendCount}×`));
    for (const s of book.sends) sendsWrap.append(renderSend(s));
  }

  // Tags editor (moves into the drawer).
  const editTags = el('button', { className: 'lib-tag-edit', type: 'button', title: 'Edit tags' },
    (book.tags && book.tags.length) ? '✎ Tags' : '＋ Tag');
  editTags.addEventListener('click', () => editBookTags(book));

  // Drawer: filename + tags editor + full history, revealed by the chevron.
  const drawer = el('div', { className: 'lib-drawer', hidden: true }, [
    book.filename && book.filename !== book.title
      ? el('div', { className: 'lib-filename hint' }, book.filename)
      : null,
    el('div', { className: 'lib-drawer-tags' }, [editTags]),
    sendsWrap,
  ]);

  // One-line send summary + disclosure chevron.
  let summaryText;
  if (!sendCount) {
    summaryText = 'Not sent yet';
  } else {
    const who = [...new Set(book.sends.flatMap((s) => s.to || []))].filter(Boolean).join(', ');
    const last = book.sends.reduce((m, s) => (s.timestamp > m ? s.timestamp : m), book.sends[0].timestamp);
    summaryText = `→ Sent to ${who || `${sendCount} reader(s)`} · last ${formatDate(last)}`;
  }
  const disclose = el('button', { className: 'lib-disclose', type: 'button', 'aria-expanded': 'false', 'aria-label': 'Show details' }, '⌄');
  disclose.addEventListener('click', () => {
    drawer.hidden = !drawer.hidden;
    disclose.setAttribute('aria-expanded', String(!drawer.hidden));
    disclose.classList.toggle('open', !drawer.hidden);
  });
  const sendSummary = el('div', { className: 'lib-send-summary' }, [
    el('span', { className: 'lib-send-summary-text' + (sendCount ? '' : ' lib-notsent') }, summaryText),
    disclose,
  ]);

  // Top-right action cluster: send/resend, optional re-download, delete.
  const actions = el('div', { className: 'lib-row-actions' });
  if (book.filePresent) {
    const resend = el('button', { className: 'primary-btn lib-send-btn', type: 'button', title: sendCount ? 'Resend' : 'Send to readers' },
      sendCount ? '📧 Resend' : '📧 Send');
    resend.addEventListener('click', () =>
      openSendModal({
        downloadId: book.id,
        // Pass the author + the exact artwork the Library is showing, so the
        // email uses the right book's cover/blurb (not a title-only guess).
        book: {
          title: book.title,
          author: book.author || '',
          cover: book.cover || resolvedLibraryCover(book) || null,
          filename: book.filename,
        },
        onSent: openLibrary, // refresh inline history after a send
      })
    );
    actions.append(resend);
  } else if (book.url && book.mode !== 'standard') {
    // Premium books can be fetched again from their forum thread.
    const rd = el('button', { className: 'ghost-btn lib-icon-btn lib-redownload', type: 'button', title: 'Re-download', 'aria-label': 'Re-download' }, '⬇');
    rd.addEventListener('click', () => redownloadBook(book));
    actions.append(rd);
  }
  const del = el('button', { className: 'ghost-btn lib-icon-btn lib-del-btn', type: 'button', title: 'Remove from library', 'aria-label': 'Remove from library' }, '🗑');
  del.addEventListener('click', () => deleteLibraryBook(book));
  actions.append(del);

  // Multi-select checkbox — hover-revealed over the cover.
  const select = el('input', { type: 'checkbox', className: 'lib-select lib-row-select', 'aria-label': `Select ${book.title || book.filename}` });
  select.checked = librarySelection.has(book.id);
  const row = el('div', { className: 'lib-book' + (select.checked ? ' selected' : '') }, [
    el('div', { className: 'lib-cover-cell' }, [buildEditableCover(book), select]),
    el('div', { className: 'lib-main' }, [
      el('h3', { className: 'lib-title' }, book.title || book.filename || 'Untitled'),
      book.author ? el('div', { className: 'lib-author' }, book.author) : null,
      metaline,
      sendSummary,
    ]),
    actions,
    drawer,
  ]);
  select.addEventListener('change', () => {
    if (select.checked) librarySelection.add(book.id);
    else librarySelection.delete(book.id);
    row.classList.toggle('selected', select.checked);
    updateLibActionBar();
  });

  return row;
}

// A library cover the user can fix when it's wrong. Shows the cover (lazy/stored)
// with a small ✎ overlay that opens an inline editor: auto-refetch from the
// catalog, or paste an image URL. Updates in place on success.
function buildEditableCover(book) {
  const mount = el('div', { className: 'lib-cover-mount' });
  function paint(coverUrl) {
    mount.innerHTML = '';
    if (coverUrl) {
      const img = el('img', { className: 'lib-cover zoomable', src: coverUrl, alt: '', loading: 'lazy', title: 'Click to enlarge' });
      img.addEventListener('click', () => openLightbox(coverUrl, book.title || ''));
      img.addEventListener('error', () => paint(null));
      mount.append(img);
    } else {
      // null cover → reuse the existing lazy/placeholder loader (catalog lookup).
      mount.append(renderLibraryCover({ ...book, cover: null }));
    }
  }
  paint(book.cover || null);

  const editBtn = el('button', { className: 'lib-cover-edit', type: 'button', title: 'Fix this cover' }, '✎');
  const editor = el('div', { className: 'lib-cover-editor', hidden: true });
  const wrap = el('div', { className: 'lib-cover-wrap' }, [mount, editBtn, editor]);
  // Lift this tile above its neighbours so the dropdown editor isn't painted
  // under sibling covers (later tiles paint on top within the grid).
  const setEditing = (on) => {
    wrap.classList.toggle('editing', on);
    wrap.closest('.lib-tile')?.classList.toggle('editing', on);
  };
  editBtn.addEventListener('click', () => {
    if (!editor.children.length) {
      buildCoverEditorBody(book, editor, (newUrl) => {
        book.cover = newUrl;
        coverCache.set(`${book.title || ''}|${book.author || ''}`.toLowerCase(), newUrl);
        paint(newUrl);
        editor.hidden = true;
        setEditing(false);
      });
    }
    editor.hidden = !editor.hidden;
    setEditing(!editor.hidden);
  });

  return wrap;
}

function buildCoverEditorBody(book, container, onDone) {
  const status = el('div', { className: 'lib-cover-status hint' }, '');
  const put = async (body, btn) => {
    const prev = btn.textContent;
    btn.disabled = true; btn.textContent = 'Working…'; status.textContent = '';
    try {
      const res = await fetch(`/api/library/${book.id}/cover`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Update failed');
      onDone(d.cover);
    } catch (e) {
      status.textContent = `⚠ ${e.message}`;
      btn.disabled = false; btn.textContent = prev;
    }
  };
  const auto = el('button', { className: 'ghost-btn lib-cover-auto', type: 'button' }, '🔄 Auto-fetch a better cover');
  auto.addEventListener('click', () => put({ refetch: true }, auto));
  const input = el('input', { className: 'lib-cover-url', type: 'url', placeholder: 'or paste an image URL (https://…)' });
  const save = el('button', { className: 'ghost-btn', type: 'button' }, 'Use URL');
  save.addEventListener('click', () => {
    const u = input.value.trim();
    if (!u) { status.textContent = 'Paste an image URL first.'; return; }
    put({ cover: u }, save);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
  container.append(
    el('div', { className: 'lib-cover-editor-row' }, [auto]),
    el('div', { className: 'lib-cover-editor-row' }, [input, save]),
    status
  );
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
    list.append(
      el('div', { className: 'lib-empty' }, [
        el('div', { className: 'lib-empty-icon' }, '🕓'),
        el('p', {}, 'No history yet.'),
        el('p', { className: 'hint' }, 'Searches, downloads, and re-upload requests will show up here.'),
      ])
    );
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

// --- Re-upload request management (issue #27) -------------------------------
// Lists the user's authoritative Mobilism requests and lets them cancel some.
const reupReqModal = $('#reupReqModal');
$('#reupReqOpen').addEventListener('click', openReupRequests);
$('#reupReqClose').addEventListener('click', () => { reupReqModal.hidden = true; });
$('#reupReqRefresh').addEventListener('click', loadReupRequests);

// Normalize a release name the same way the server does, for history matching.
const normReup = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

async function openReupRequests() {
  reupReqModal.hidden = false;
  await loadReupRequests();
}

async function loadReupRequests() {
  const body = $('#reupReqBody');
  const cancelBtn = $('#reupReqCancelSel');
  cancelBtn.hidden = true;
  body.innerHTML = '<p class="hint">Loading your requests…</p>';
  try {
    const res = await fetch('/api/reupload/requests');
    if (res.status === 409) {
      const d = await res.json().catch(() => ({}));
      body.innerHTML = '';
      body.append(el('p', { className: 'reup-msg warn' }, d.error || 'Session needs re-warming.'));
      body.append(el('a', { className: 'warm-btn', href: '/warm', target: '_blank', rel: 'noopener' }, 'Re-warm ↗'));
      return;
    }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not load requests.');
    const data = await res.json();
    renderReupRequests(data);
  } catch (err) {
    body.innerHTML = '';
    body.append(el('p', { className: 'reup-msg error' }, err.message || 'Could not load requests.'));
  }
}

function renderReupRequests(data) {
  const body = $('#reupReqBody');
  const cancelBtn = $('#reupReqCancelSel');
  body.innerHTML = '';
  const requests = (data && data.requests) || [];
  const hist = (data && data.history) || [];

  if (!requests.length) {
    cancelBtn.hidden = true;
    body.append(
      el('div', { className: 'lib-empty' }, [
        el('div', { className: 'lib-empty-icon' }, '↻'),
        el('p', {}, 'No pending re-upload requests.'),
        el('p', { className: 'hint' }, 'Requests you make from a result will show up here.'),
      ])
    );
    return;
  }

  const selected = new Set();
  for (const r of requests) {
    const cb = el('input', { type: 'checkbox', className: 'reupreq-check' });
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(r.releaseName);
      else selected.delete(r.releaseName);
      cancelBtn.hidden = selected.size === 0;
      cancelBtn.textContent = `Cancel selected (${selected.size})`;
    });

    // Deep-link back to the in-app thread if local history recorded this request.
    const match = hist.find((h) => h.title && normReup(r.releaseName).includes(normReup(h.title)));
    const title = match && match.url
      ? el('a', { className: 'reupreq-name', href: match.url, target: '_blank', rel: 'noopener' }, r.releaseName)
      : el('span', { className: 'reupreq-name' }, r.releaseName);

    const meta = el('div', { className: 'reupreq-meta hint' },
      `Requested ${r.requestedOn || '—'} · releaser last online ${r.releaserLastOnline || '—'}`);

    body.append(el('label', { className: 'reupreq-row' }, [cb, el('div', { className: 'reupreq-main' }, [title, meta])]));
  }

  cancelBtn.hidden = true;
  cancelBtn.textContent = 'Cancel selected';
  cancelBtn.onclick = async () => {
    if (!selected.size) return;
    cancelBtn.disabled = true;
    const prev = cancelBtn.textContent;
    cancelBtn.textContent = 'Cancelling…';
    try {
      const res = await fetch('/api/reupload/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ releaseNames: [...selected] }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Cancel failed.');
      await loadReupRequests(); // reflect Mobilism's authoritative state
    } catch (err) {
      cancelBtn.disabled = false;
      cancelBtn.textContent = prev;
      body.prepend(el('p', { className: 'reup-msg error' }, err.message || 'Cancel failed.'));
    }
  };
}

// --- Watchlist (issue #7) ---------------------------------------------------
const watchlistModal = $('#watchlistModal');
let watchRecipientsList = []; // [{id, name, hasKindle}] for relating to a watch
$('#watchlistToggle').addEventListener('click', openWatchlist);
$('#watchlistClose').addEventListener('click', () => { watchlistModal.hidden = true; });
$('#watchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('#watchTitle').value.trim();
  const author = $('#watchAuthor').value.trim();
  if (!title && !author) return;
  const recipientIds = [...$('#watchAddRecipients').querySelectorAll('input:checked')].map((c) => c.value);
  try {
    const res = await fetch('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, author, sort: 'newest', recipientIds }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not add watch');
    $('#watchTitle').value = '';
    $('#watchAuthor').value = '';
    await loadWatchlist();
  } catch (err) {
    const n = $('#watchlistNotice');
    n.hidden = false; n.textContent = err.message;
  }
});

// Render the recipient checkboxes used both in the add-form and the per-row
// editor. `selected` is a Set of pre-checked ids.
function recipientCheckboxes(selected) {
  if (!watchRecipientsList.length) {
    return [el('span', { className: 'hint' }, 'No recipients yet — add them from a download’s “Send” dialog.')];
  }
  return watchRecipientsList.map((r) => {
    const cb = el('input', { type: 'checkbox', value: r.id });
    cb.checked = selected.has(r.id);
    return el('label', { className: 'watch-recip' }, [
      cb, `${r.name}${r.hasKindle ? ' 📖' : ''}`,
    ]);
  });
}

async function openWatchlist() {
  watchlistModal.hidden = false;
  await loadWatchlist();
}

let watchlistLoadSeq = 0; // stale-response guard: only the newest load may paint
async function loadWatchlist() {
  const seq = ++watchlistLoadSeq;
  const body = $('#watchlistBody');
  body.innerHTML = '<p class="hint">Loading…</p>';
  try {
    const data = await fetch('/api/watchlist').then((r) => r.json());
    if (seq !== watchlistLoadSeq) return; // a newer load superseded this one
    const notice = $('#watchlistNotice');
    if (!data.emailReady) {
      notice.hidden = false;
      notice.textContent = '⚠ Email isn’t configured (SMTP_*), so watch notifications can’t be delivered yet.';
    } else if (data.notifyTo) {
      notice.hidden = false;
      notice.className = 'hint';
      notice.textContent = `Notifications go to ${data.notifyTo}.`;
    } else {
      notice.hidden = true;
    }
    watchRecipientsList = data.recipients || [];
    // (Re)render the add-form recipient chooser.
    const addBox = $('#watchAddRecipients');
    addBox.innerHTML = '';
    if (watchRecipientsList.length && watchRecipientsList.length <= 3) {
      addBox.append(el('span', { className: 'watch-recip-label' }, 'Send to:'));
      for (const node of recipientCheckboxes(new Set())) addBox.append(node);
    } else if (watchRecipientsList.length) {
      // >3 recipients: tuck the checkbox strip behind a live-counting toggle so
      // the add form stays compact.
      const strip = el('div', { className: 'watch-recipients-strip', hidden: true });
      strip.append(el('span', { className: 'watch-recip-label' }, 'Send to:'));
      for (const node of recipientCheckboxes(new Set())) strip.append(node);
      const toggle = el('button', { className: 'watch-recip-edit', type: 'button', 'aria-expanded': 'false' }, 'Send to: 0 selected ⌄');
      const updateLabel = () => {
        const n = strip.querySelectorAll('input:checked').length;
        toggle.textContent = `Send to: ${n} selected ${strip.hidden ? '⌄' : '⌃'}`;
      };
      strip.addEventListener('change', updateLabel);
      toggle.addEventListener('click', () => { strip.hidden = !strip.hidden; toggle.setAttribute('aria-expanded', String(!strip.hidden)); updateLabel(); });
      addBox.append(toggle, strip);
    }
    renderWatchlist(data.watches || []);
  } catch (err) {
    if (seq !== watchlistLoadSeq) return; // a newer load superseded this one
    body.innerHTML = '';
    body.append(el('p', { className: 'reup-msg error' }, err.message || 'Could not load the watchlist.'));
  }
}

function watchStatusBadge(w) {
  const map = {
    active: ['Active', 'ok-badge'],
    paused: ['Paused', ''],
    fulfilled: ['Found ✓', 'ok-badge'],
    expired: ['Expired', ''],
  };
  const [label, cls] = map[w.status] || [w.status, ''];
  const badge = el('span', { className: 'badge ' + cls }, label);
  // List-origin watches carry a provenance badge so hand-added ones stand out.
  if (w.source !== 'list') return badge;
  return el('span', { className: 'watch-badges' }, [badge, el('span', { className: 'badge', title: w.listLabel || 'From a bestseller list' }, '📈 List')]);
}

function renderWatchlist(watches) {
  const body = $('#watchlistBody');
  body.innerHTML = '';
  if (!watches.length) {
    body.append(
      el('div', { className: 'lib-empty' }, [
        el('div', { className: 'lib-empty-icon' }, '🔔'),
        el('p', {}, 'No watches yet.'),
        el('p', { className: 'hint' }, 'Add one above, or hit “Watch for this book” on a not-found search.'),
      ])
    );
    return;
  }
  for (const w of watches) {
    const label = [w.title && `“${w.title}”`, w.author && `by ${w.author}`].filter(Boolean).join(' ') || '(any)';
    const head = el('div', { className: 'watch-head' }, [
      el('span', { className: 'watch-q' }, label),
      watchStatusBadge(w),
    ]);

    // Status line — always rendered. Either the last-checked summary, or a
    // warn-colored error chip when the last check failed.
    const checked = w.lastCheckedAt ? `checked ${formatDate(w.lastCheckedAt)} · ${w.checkCount || 0}×` : 'not checked yet';
    const statusLine = el('div', { className: 'watch-status-line' }, [
      w.lastError
        ? el('span', { className: 'watch-error-chip', title: w.lastError }, `⚠ ${w.lastError}`)
        : el('span', {}, checked),
    ]);

    // Delivery line — only for fulfilled watches: the match link + send counts.
    let deliveryLine = null;
    if (w.status === 'fulfilled') {
      const dbits = [];
      if (w.foundUrl) dbits.push(el('a', { href: w.foundUrl, target: '_blank', rel: 'noopener' }, 'Open the match ↗'));
      if (w.delivered || w.kindlePushed) {
        dbits.push(el('span', {}, `sent to ${w.delivered || 0}${w.kindlePushed ? `, ${w.kindlePushed} to Kindle` : ''}`));
      }
      if (dbits.length) deliveryLine = el('div', { className: 'watch-delivery-line' }, dbits);
    }
    const metaLines = [statusLine, deliveryLine].filter(Boolean);

    // Recipients this watch auto-delivers to (Kindle + notification on a match).
    const ids = Array.isArray(w.recipientIds) ? w.recipientIds : [];
    const names = ids
      .map((id) => (watchRecipientsList.find((r) => r.id === id) || {}).name)
      .filter(Boolean);
    const recipLine = el('div', { className: 'watch-recip-line hint' },
      names.length ? `→ ${names.join(', ')}` : '→ no recipients (operator notified only)');
    const editLink = el('button', { className: 'watch-recip-edit', type: 'button' }, 'Recipients');
    const editor = el('div', { className: 'watch-recip-editor', hidden: true });
    editLink.addEventListener('click', () => {
      if (editor.children.length === 0) {
        for (const node of recipientCheckboxes(new Set(ids))) editor.append(node);
        const save = el('button', { className: 'ghost-btn', type: 'button' }, 'Save recipients');
        save.addEventListener('click', async () => {
          const recipientIds = [...editor.querySelectorAll('input:checked')].map((c) => c.value);
          save.disabled = true; save.textContent = 'Saving…';
          await fetch(`/api/watchlist/${w.id}/recipients`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipientIds }),
          });
          await loadWatchlist();
        });
        editor.append(el('div', { className: 'watch-recip-save' }, [save]));
      }
      editor.hidden = !editor.hidden;
    });
    recipLine.append(el('span', {}, ' '), editLink);

    // Actions: pause/resume, check now, remove.
    const actions = el('div', { className: 'watch-actions' });
    if (w.status !== 'fulfilled') {
      const checkBtn = el('button', { className: 'ghost-btn', type: 'button' }, 'Check now');
      checkBtn.addEventListener('click', async () => {
        checkBtn.disabled = true; checkBtn.textContent = 'Checking…';
        try {
          const res = await fetch(`/api/watchlist/${w.id}/check`, { method: 'POST' });
          const d = await res.json().catch(() => ({}));
          if (res.status === 409) { checkBtn.textContent = 'Re-warm needed'; return; }
          if (!res.ok) throw new Error(d.error || 'Check failed');
        } catch { /* surfaced on reload */ }
        await loadWatchlist();
      });
      actions.append(checkBtn);

      const toggle = el('button', { className: 'ghost-btn watch-icon-btn', type: 'button', title: w.status === 'paused' ? 'Resume' : 'Pause', 'aria-label': w.status === 'paused' ? 'Resume watch' : 'Pause watch' }, w.status === 'paused' ? '▶' : '⏸');
      toggle.addEventListener('click', async () => {
        toggle.disabled = true;
        await fetch(`/api/watchlist/${w.id}/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: w.status === 'paused' ? 'active' : 'paused' }),
        });
        await loadWatchlist();
      });
      actions.append(toggle);
    } else {
      const again = el('button', { className: 'ghost-btn', type: 'button' }, 'Watch again');
      again.addEventListener('click', async () => {
        again.disabled = true;
        await fetch(`/api/watchlist/${w.id}/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'active' }),
        });
        await loadWatchlist();
      });
      actions.append(again);
    }
    const del = el('button', { className: 'ghost-btn watch-del watch-icon-btn', type: 'button', title: 'Remove', 'aria-label': 'Remove watch' }, '🗑');
    del.addEventListener('click', async () => {
      del.disabled = true; del.textContent = '…';
      try {
        const res = await fetch(`/api/watchlist/${w.id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`Remove failed (HTTP ${res.status}) — try again.`);
        await loadWatchlist(); // {ok:false} body = already gone server-side; reload clears the stale row either way
      } catch (err) {
        const n = $('#watchlistNotice');
        n.hidden = false;
        n.className = 'reup-msg warn';
        n.textContent = err.message || 'Could not remove the watch.';
        del.disabled = false; del.textContent = '🗑';
      }
    });
    actions.append(del);

    const main = el('div', { className: 'watch-row-main' }, [head, ...metaLines, recipLine, editor]);
    body.append(el('div', { className: 'watch-row' }, [buildWatchCover(w), main, actions]));
  }
}

// Lazy book cover for a watchlist row. Looked up by { title, author } via
// /api/cover (disk-cached server-side). Falls back to a glyph when there's no
// confident cover or the watch has no title/author to look up.
function buildWatchCover(w) {
  const slot = el('div', { className: 'watch-cover' });
  if (!w.title && !w.author) {
    slot.append(el('div', { className: 'watch-cover-ph' }, '🔔'));
    return slot;
  }
  slot.append(el('div', { className: 'watch-cover-ph' }, '📖'));
  const params = new URLSearchParams();
  if (w.title) params.set('title', w.title);
  if (w.author) params.set('author', w.author);
  fetch(`/api/cover?${params.toString()}`)
    .then((r) => r.json())
    .then((d) => {
      if (!d || !d.cover) return;
      slot.innerHTML = '';
      const img = el('img', { className: 'watch-cover-img zoomable', src: d.cover, alt: 'cover', loading: 'lazy', title: 'Click to enlarge' });
      img.addEventListener('click', () => openLightbox(d.cover, w.title || ''));
      slot.append(img);
    })
    .catch(() => { /* keep the glyph */ });
  return slot;
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
  } else if (entry.type === 'watch-hit') {
    const label = [entry.title && `“${entry.title}”`, entry.author && `by ${entry.author}`].filter(Boolean).join(' ');
    item.append(el('div', {}, `🔔 Watch matched — ${label || 'a book'} is available`));
    if (entry.url) item.append(el('a', { className: 'hint', href: entry.url, target: '_blank', rel: 'noopener' }, 'Open the match ↗'));
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
// AbortController for the in-flight batch search; non-null only while one runs.
// Aborting it closes the SSE stream so the server cancels the batch scrape.
let batchAbort = null;

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

  // Take over the results area with the batch view. A Cancel button aborts the
  // fetch, which closes the SSE stream → the server stops the batch scrape (so a
  // closed/refreshed page can't leave it running rogue).
  hideStatus();
  resultsEl.innerHTML = '';
  batchRows.clear();
  batchAbort = new AbortController();
  const cancelBtn = el('button', { className: 'batch-cancel-btn', type: 'button' }, 'Cancel');
  cancelBtn.addEventListener('click', () => { if (batchAbort) batchAbort.abort(); });
  const header = el('div', { className: 'batch-header' }, [
    el('h2', { className: 'batch-title' }, 'Batch results'),
    el('div', { className: 'batch-progress', id: 'batchProgress' }, [
      el('span', { className: 'spinner' }), 'Starting…',
    ]),
    cancelBtn,
  ]);
  const rowsWrap = el('div', { className: 'batch-rows', id: 'batchRowsWrap' });
  const actionBar = el('div', { className: 'batch-actionbar', id: 'batchActionBar', hidden: true });
  resultsEl.append(header, rowsWrap, actionBar);

  try {
    const res = await fetch('/api/search/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sort }),
      signal: batchAbort.signal,
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
    // The user cancelled — aborting the fetch lands here. Not an error.
    if (err && err.name === 'AbortError') {
      setBatchProgress('Batch cancelled.', false);
    } else {
      setBatchProgress(`✕ ${err.message}`, false);
    }
  } finally {
    batchAbort = null;
    if (cancelBtn.isConnected) cancelBtn.remove();
  }
}

// Short pill labels for the per-row phase updates during a batch search. Mirrors
// the single-search showSearchProgress() phases, trimmed to fit a status pill.
function batchPhaseLabel(ev) {
  const msgs = {
    'title-search': 'Searching titles…',
    'scanning': `Scanning…${ev.found ? ` (${ev.found})` : ''}`,
    'collections': 'Checking sets…',
    'author-collections': 'Books-by-author…',
    'author-fallback': 'Author search…',
  };
  return msgs[ev.phase] || 'Searching…';
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
    case 'progress':
      // Live phase update for the book currently being searched — gives the row
      // a sense of movement, same phases the single search shows.
      setRowPill(ev.index, 'searching', batchPhaseLabel(ev));
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
// When the entry matched several posts, ALL of them ride along as fallback
// candidates (chosen one first) so the server keeps looking — and verifying —
// until one post yields the right book, instead of giving up on the first.
async function downloadOneBatch(r, chosen, note) {
  const fallbacks = (r.candidates || [])
    .filter((c) => c !== chosen && c.premium && c.url)
    .map((c) => ({ url: c.url, title: c.title }));
  const res = await fetch('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: chosen.url, title: chosen.title, searchedTitle: r.entry.title, candidates: fallbacks }),
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
      case 'candidate': setNote(note, 'working', `⏳ Match ${ev.index}/${ev.total}${ev.title ? ' · ' + ev.title : ''}`); break;
      case 'candidate-failed': setNote(note, 'working', `⏳ Match ${ev.index}/${ev.total} failed — trying the next…`); break;
      case 'reading-post': setNote(note, 'working', '⏳ Reading post…'); break;
      case 'mirrors-found': setNote(note, 'working', `⏳ ${ev.total} mirror${ev.total === 1 ? '' : 's'} found`); break;
      case 'mirror': setNote(note, 'working', `⏳ Mirror ${ev.index}/${ev.total}${ev.host ? ' · ' + ev.host : ''}`); break;
      case 'mirror-mismatch': setNote(note, 'working', '⏳ That file wasn’t the right book — trying the next mirror…'); break;
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
      book: { title: r.entry.title, author: r.entry.author || '', filename: r.filename },
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

// ---------------------------------------------------------------------------
// Focus management for modals/drawers (a11y): trap Tab within the top-most open
// surface, focus the first control when one opens, and restore focus to whatever
// opened it on close. Surfaces are listed in dismissal priority (top-most first).
// ---------------------------------------------------------------------------
const FOCUS_SURFACES = ['#settingsModal', '#statusModal', '#sendModal', '#credModal', '#batchModal', '#downloadModal', '#libraryPanel', '#historyPanel'];
let focusReturnEl = null;

function focusablesIn(container) {
  const sel = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll(sel))
    .filter((e) => e.offsetWidth > 0 || e.offsetHeight > 0 || e === document.activeElement);
}

function topOpenSurface() {
  for (const s of FOCUS_SURFACES) {
    const n = $(s);
    if (n && !n.hidden) return n;
  }
  return null;
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const surface = topOpenSurface();
  if (!surface) return;
  const f = focusablesIn(surface);
  if (!f.length) { e.preventDefault(); return; }
  const first = f[0];
  const last = f[f.length - 1];
  if (!surface.contains(document.activeElement)) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

// Watch each surface's `hidden` attribute: on open, remember the opener and focus
// the first control; on close, hand focus back to the opener.
const surfaceObserver = new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.attributeName !== 'hidden') continue;
    const node = m.target;
    if (!node.hidden) {
      if (!node.contains(document.activeElement)) focusReturnEl = document.activeElement;
      const f = focusablesIn(node);
      if (f.length) f[0].focus();
    } else if (focusReturnEl && typeof focusReturnEl.focus === 'function' && !topOpenSurface()) {
      focusReturnEl.focus();
      focusReturnEl = null;
    }
  }
});
FOCUS_SURFACES.forEach((s) => {
  const n = $(s);
  if (n) surfaceObserver.observe(n, { attributes: true, attributeFilter: ['hidden'] });
});

// ---------------------------------------------------------------------------
// Global keyboard: Escape dismisses the top-most open surface. The download
// modal is only dismissible once its close button is shown (i.e. the download
// has settled), matching the existing click-to-close affordance.
// ---------------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const lb = $('#lightbox');
  if (lb && !lb.hidden) return closeLightbox();
  if (!$('#settingsModal').hidden) return closeSettings();
  if (!$('#statusModal').hidden) return closeStatus();
  if (!sendModal.hidden) return closeSendModal();
  if (!credModal.hidden) return closeCredModal();
  if (!batchModal.hidden) { batchModal.hidden = true; return; }
  if (!downloadModal.hidden && !$('#dlClose').hidden) return closeDownloadModal();
  if (!libraryPanel.hidden) return closeLibrary();
  if (!historyPanel.hidden) return closeHistory();
});

// Run the deep-link prefill last, so every module-level binding runSearch reads
// (lastSearchParams, etc.) is already initialized — avoids a TDZ ReferenceError.
prefillFromQuery();
