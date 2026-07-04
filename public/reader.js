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

  // Arriving from the email's "Stop these emails" link.
  if (qs.get('unsub') === '1') $('#unsub').click();
})();
