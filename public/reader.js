(async function () {
  const qs = new URLSearchParams(location.search);
  const t = qs.get('t') || '';
  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs = {}, kids = []) => {
    const n = document.createElement(tag);
    Object.assign(n, attrs);
    for (const k of [].concat(kids)) if (k) n.append(k);
    return n;
  };

  if (!t) {
    $('#greet').textContent = 'This shelf needs its key.';
    $('#main').textContent = 'Open the personal link from your invite email — it unlocks your shelf automatically.';
    return;
  }

  // Point the web app manifest at THIS reader's shelf, so an installed
  // home-screen icon opens straight to their books (Android/Chrome).
  const mani = document.createElement('link');
  mani.rel = 'manifest';
  mani.href = '/reader/manifest.webmanifest?t=' + encodeURIComponent(t);
  document.head.append(mani);

  setupInstallHint(t, $, el);

  let data;
  try {
    const res = await fetch('/reader/api/books?t=' + encodeURIComponent(t));
    if (!res.ok) throw new Error(res.status);
    data = await res.json();
  } catch {
    $('#greet').textContent = 'Hmm, that link didn’t work.';
    $('#main').textContent = 'This shelf link is no longer valid. Ask Eric for a fresh invite.';
    return;
  }

  $('#greet').textContent = `Hi ${data.name} — here’s your book library. Tap to send any of them to your Kindle.`;
  $('#foot').hidden = false;

  if (!data.kindleSet) {
    $('#banner').append(el('div', { className: 'note warn' },
      '⚠ No Kindle address is saved for you yet — ask Eric to add it, then these buttons will work.'));
  }

  // One tile builder shared by the recent-shelf grid and search results, so
  // both render identically and POST the same send call.
  function renderTile(b, kindleSet) {
    const cover = b.cover
      ? el('img', { className: 'cover', src: b.cover, alt: '', loading: 'lazy' })
      : el('div', { className: 'cover ph' }, '📕');
    if (cover.tagName === 'IMG') cover.onerror = () => cover.replaceWith(el('div', { className: 'cover ph' }, '📕'));
    const err = el('div', { className: 'err' });
    const btn = el('button', { className: 'send' + (b.sent ? ' sent' : ''), type: 'button' },
      b.sent ? '✓ On your Kindle' : '📤 Send to my Kindle');
    btn.disabled = b.sent || !kindleSet;
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Sending…';
      err.textContent = '';
      try {
        const res = await fetch('/reader/api/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ t, id: b.id }),
        });
        const out = await res.json();
        if (!res.ok) throw new Error(out.error || 'Send failed');
        btn.classList.add('sent');
        btn.textContent = '✓ On its way!';
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '📤 Send to my Kindle';
        err.textContent = e.message;
      }
    };
    return el('div', { className: 'tile' }, [
      cover,
      el('div', { className: 't' }, b.title),
      b.author ? el('div', { className: 'a' }, b.author) : null,
      btn,
      err,
    ]);
  }

  const main = $('#main');
  main.className = '';
  main.textContent = '';
  if (!data.books.length) {
    main.className = 'center';
    main.textContent = 'No books on your shelf yet — check back soon. 📭';
  } else {
    const grid = el('div', { className: 'grid' });
    for (const b of data.books) grid.append(renderTile(b, data.kindleSet));
    main.append(grid);
    setupLazyShelf({ $, el, t, grid, renderTile, kindleSet: data.kindleSet, offset: data.offset, limit: data.limit, hasMore: data.hasMore });
  }

  setupSearch(t, $, el, renderTile);

  $('#unsub').onclick = async (e) => {
    e.preventDefault();
    try {
      await fetch('/reader/api/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ t }),
      });
      $('#unsub').replaceWith('Emails stopped — your shelf link keeps working. 👋');
    } catch { /* ignore */ }
  };

  // Arriving from the email's "Stop these emails" link: ask, don't act.
  // Auto-firing the unsubscribe here would let email link-scanners (which
  // sometimes execute JS) silently unsubscribe readers just by prefetching.
  if (qs.get('unsub') === '1') {
    const yes = el('button', { className: 'add', type: 'button', textContent: 'Yes, stop the emails' });
    const no = el('button', { className: 'plain', type: 'button', textContent: 'Keep them' });
    const bar = el('div', { className: 'note' }, [
      el('div', { style: 'margin-bottom:10px' }, 'Stop the new-book emails? Your shelf link keeps working either way.'),
      yes, ' ', no,
    ]);
    yes.onclick = () => { bar.remove(); $('#unsub').click(); };
    no.onclick = () => bar.remove();
    $('#banner').append(bar);
  }
})();

// A gentle, dismissable "Add BookHunt to your home screen" hint. Written for
// non-technical readers: plain words, no jargon, and it never blocks the page.
// - Android/Chrome: we get a real one-tap install via beforeinstallprompt.
// - iOS/Safari: no programmatic install exists, so we show the exact taps.
// - Already installed (standalone) or dismissed before: show nothing.
function setupInstallHint(t, $, el) {
  const box = document.getElementById('install');
  if (!box) return;

  const standalone = window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
  if (standalone) return;                          // already added — don't nag
  try { if (localStorage.getItem('bh_install_dismissed') === '1') return; } catch { /* ok */ }

  const ua = navigator.userAgent || '';
  const isiOS = /iphone|ipad|ipod/i.test(ua) || (/mac/i.test(ua) && 'ontouchend' in document);

  const icon = el('img', { src: '/reader/icon-192.png', alt: '' });
  const dismiss = el('button', { className: 'x', type: 'button', title: 'Not now', textContent: '✕' });
  dismiss.onclick = () => {
    box.hidden = true;
    try { localStorage.setItem('bh_install_dismissed', '1'); } catch { /* ok */ }
  };

  const show = (inner) => {
    box.innerHTML = '';
    box.append(icon, inner, dismiss);
    box.hidden = false;
  };

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    const add = el('button', { className: 'add', type: 'button', textContent: 'Add' });
    add.onclick = async () => {
      box.hidden = true;
      e.prompt();
      try { await e.userChoice; } catch { /* ok */ }
    };
    box.innerHTML = '';
    box.append(icon,
      el('div', { className: 'it' }, [
        el('b', { textContent: 'Add BookHunt to your phone' }),
        el('span', { textContent: 'One tap puts it on your home screen like an app.' }),
      ]), add, dismiss);
    box.hidden = false;
  });

  if (isiOS) {
    // iOS gives us no install event — guide the two taps, gently.
    show(el('div', { className: 'it' }, [
      el('b', { textContent: 'Add BookHunt to your home screen' }),
      el('span', { textContent: 'Tap the Share button below, then “Add to Home Screen.”' }),
    ]));
  }
  // Non-iOS without a beforeinstallprompt (e.g. desktop, or already eligible
  // later): the event handler above will reveal the hint if/when it fires.
}

// Lazy-loads further pages of the shelf as the reader scrolls near the
// bottom. A sentinel div sits after the grid; an IntersectionObserver fires
// when it nears the viewport (rootMargin gives it a head start), fetches the
// next page, and appends tiles to the SAME grid so it just keeps growing.
// While a search is active, #main (and this sentinel with it) is hidden —
// a hidden ancestor never intersects, so lazy-loading naturally pauses
// without any extra guard.
function setupLazyShelf({ $, el, t, grid, renderTile, kindleSet, offset, limit, hasMore }) {
  if (!hasMore) return;
  const main = $('#main');
  const sentinel = el('div', { className: 'shelfSentinel' });
  main.append(sentinel);

  let nextOffset = offset + limit;
  let pageLimit = limit;
  let loading = false;
  let more = hasMore;

  const io = new IntersectionObserver(async (entries) => {
    if (!more || loading || !entries.some((e) => e.isIntersecting)) return;
    loading = true;
    try {
      const res = await fetch(`/reader/api/books?t=${encodeURIComponent(t)}&offset=${nextOffset}&limit=${pageLimit}`);
      if (!res.ok) throw new Error(res.status);
      const page = await res.json();
      for (const b of page.books) grid.append(renderTile(b, kindleSet));
      nextOffset = page.offset + page.limit;
      pageLimit = page.limit;
      more = page.hasMore;
      if (!more) {
        io.disconnect();
        sentinel.remove();
      } else {
        // The sentinel may still be sitting inside the (generous) rootMargin
        // after this page's tiles were appended — e.g. a short shelf on a
        // tall screen — in which case its `isIntersecting` state never
        // actually changes, so the observer would never fire again on its
        // own. Re-observing forces a fresh intersection check against the
        // now-taller page, which is what keeps loading chaining until the
        // sentinel truly leaves the margin or hasMore runs out.
        io.unobserve(sentinel);
        io.observe(sentinel);
      }
    } catch {
      // Fail quiet — a flaky lazy-load shouldn't break the shelf; the reader
      // can scroll again (retriggers the observer) or reload.
    } finally {
      loading = false;
    }
  }, { rootMargin: '600px' });
  io.observe(sentinel);
}

// Reusable "what's new" spotlight: highlights a feature on the reader's FIRST
// visit after it ships, then never again. Use this for any future addition to
// the shelf instead of a one-off banner — give each feature a stable `id`
// (bump it, e.g. "-v2", if you re-introduce the same UI element for a
// materially different feature later so it re-announces). Persisted in
// localStorage per browser/device (same posture as the install-hint dismiss
// flag), since the reader portal has no server-side "seen" state to hang this
// off — a leaked/shared link seeing the tip again is harmless.
function spotlightFeature({ id, target, title, body, el }) {
  if (!id || !target) return;
  const key = 'bh_spotlight_' + id;
  try { if (localStorage.getItem(key) === '1') return; } catch { /* no storage — just skip the tip */ }

  target.classList.add('spotlight-ring');
  const dismiss = () => {
    target.classList.remove('spotlight-ring');
    bubble.remove();
    try { localStorage.setItem(key, '1'); } catch { /* ok, will just show again next visit */ }
  };
  const btn = el('button', { type: 'button', textContent: 'Got it' });
  btn.onclick = dismiss;
  const bubble = el('div', { className: 'spotlight-bubble' }, [
    el('div', { className: 'st' }, title),
    el('div', { className: 'sb' }, body),
    btn,
  ]);
  target.insertAdjacentElement('afterend', bubble);
}

// Search box for the WHOLE library (not just the recent shelf) + the
// "not found → ask BookHunt to watch for it" flow. `renderTile` is the same
// tile builder the recent shelf uses, so search hits look and behave
// identically (same Send-to-Kindle path).
function setupSearch(t, $, el, renderTile) {
  const form = $('#searchForm');
  const input = $('#searchInput');
  const results = $('#searchResults');
  const clearBtn = $('#searchClear');
  const main = $('#main');
  if (!form || !input || !results) return;
  form.hidden = false;

  spotlightFeature({
    id: 'shelf-search-2026-07',
    target: form,
    title: '🔍 New: search your whole library',
    body: 'Find any book on your shelf, or ask us to watch for one we don’t have yet — right from here.',
    el,
  });

  // The recent-shelf grid (#main) only makes sense when the reader isn't
  // actively searching — while search results (or the not-found state) are
  // showing, hide it so the two lists don't blur together.
  function setSearching(active) {
    if (main) main.hidden = active;
  }

  function notFoundForm(query) {
    const titleInput = el('input', { type: 'text', placeholder: 'Title', value: query, maxLength: 300 });
    const authorInput = el('input', { type: 'text', placeholder: 'Author (optional)', maxLength: 300 });
    const err = el('div', { className: 'err' });
    const btn = el('button', { className: 'add', type: 'submit' }, 'Ask BookHunt to find it');
    const wf = el('form', { className: 'watchForm' }, [titleInput, authorInput, btn, err]);
    wf.onsubmit = async (e) => {
      e.preventDefault();
      btn.disabled = true;
      btn.textContent = 'Asking…';
      err.textContent = '';
      try {
        const res = await fetch('/reader/api/watchlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ t, title: titleInput.value, author: authorInput.value }),
        });
        const out = await res.json();
        if (!res.ok) throw new Error(out.error || 'Could not add the watch.');
        wf.replaceWith(el('div', { textContent: 'We’ll email you when we find it 📬' }));
      } catch (e2) {
        btn.disabled = false;
        btn.textContent = 'Ask BookHunt to find it';
        err.textContent = e2.message;
      }
    };
    return el('div', { className: 'note' }, [
      el('div', { style: 'margin-bottom:10px' }, `Couldn’t find “${query}” on the shelf. Want us to keep looking?`),
      wf,
    ]);
  }

  // Search-as-you-type: debounced so each keystroke doesn't fire its own
  // request, plus a sequence guard so a slow response for an old query can't
  // clobber the screen after a newer keystroke already replaced it.
  let seq = 0;
  function clearResults() {
    seq++; // invalidate any in-flight request so its response is dropped
    results.className = '';
    results.textContent = '';
    setSearching(false);
  }

  async function runSearch(q) {
    const mySeq = ++seq;
    if (!q) {
      results.className = '';
      results.textContent = '';
      setSearching(false);
      return;
    }
    setSearching(true);
    results.className = 'center';
    results.textContent = 'Searching…';
    let data;
    try {
      const res = await fetch('/reader/api/search?t=' + encodeURIComponent(t) + '&q=' + encodeURIComponent(q));
      if (!res.ok) throw new Error(res.status);
      data = await res.json();
    } catch {
      if (mySeq !== seq) return;
      results.className = '';
      results.textContent = '';
      results.append(el('div', { className: 'note' }, 'Search didn’t work — try again in a moment.'));
      return;
    }
    if (mySeq !== seq) return; // a newer keystroke already superseded this response
    results.className = '';
    results.textContent = '';
    if (data.books.length) {
      const grid = el('div', { className: 'grid' });
      for (const b of data.books) grid.append(renderTile(b, data.kindleSet));
      results.append(el('h2', {}, 'Found in the library'), grid);
    } else {
      results.append(notFoundForm(q));
    }
  }

  let debounceTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (clearBtn) clearBtn.hidden = !q;
    if (q.length < 2) {
      clearResults();
      return;
    }
    debounceTimer = setTimeout(() => runSearch(q), 350);
  });

  form.onsubmit = (e) => {
    e.preventDefault();
    clearTimeout(debounceTimer);
    runSearch(input.value.trim());
  };

  if (clearBtn) {
    clearBtn.onclick = () => {
      clearTimeout(debounceTimer);
      input.value = '';
      clearBtn.hidden = true;
      clearResults();
      input.focus();
    };
  }
}
