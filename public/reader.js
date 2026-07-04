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

  $('#greet').textContent = `Hi ${data.name} — new books from the last ${data.days} days. Tap to send any of them to your Kindle.`;
  $('#foot').hidden = false;

  if (!data.kindleSet) {
    $('#banner').append(el('div', { className: 'note warn' },
      '⚠ No Kindle address is saved for you yet — ask Eric to add it, then these buttons will work.'));
  }

  const main = $('#main');
  main.className = '';
  main.textContent = '';
  if (!data.books.length) {
    main.className = 'center';
    main.textContent = 'Nothing new on the shelf right now — you’ll get an email when fresh books arrive. 📭';
    return;
  }

  const grid = el('div', { className: 'grid' });
  for (const b of data.books) {
    const cover = b.cover
      ? el('img', { className: 'cover', src: b.cover, alt: '', loading: 'lazy' })
      : el('div', { className: 'cover ph' }, '📕');
    if (cover.tagName === 'IMG') cover.onerror = () => cover.replaceWith(el('div', { className: 'cover ph' }, '📕'));
    const err = el('div', { className: 'err' });
    const btn = el('button', { className: 'send' + (b.sent ? ' sent' : ''), type: 'button' },
      b.sent ? '✓ On your Kindle' : '📤 Send to my Kindle');
    btn.disabled = b.sent || !data.kindleSet;
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
    grid.append(el('div', { className: 'tile' }, [
      cover,
      el('div', { className: 't' }, b.title),
      b.author ? el('div', { className: 'a' }, b.author) : null,
      btn,
      err,
    ]));
  }
  main.append(grid);

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
