'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const kit = require('../src/notify/emailkit');

test('emailkit.escapeHtml: escapes markup + quotes; null/undefined → empty', () => {
  assert.equal(kit.escapeHtml(`<a href="x">Tom's & co</a>`), '&lt;a href=&quot;x&quot;&gt;Tom&#39;s &amp; co&lt;/a&gt;');
  assert.equal(kit.escapeHtml(null), '');
  assert.equal(kit.escapeHtml(undefined), '');
  assert.equal(kit.escapeHtml(0), '0');
});

test('emailkit.emailShell: wordmark, sub-header, body, footer note + signature', () => {
  const html = kit.emailShell('Hello', '<tr><td>BODY</td></tr>', 'Small print', 'Sig line');
  for (const s of ['Book<span', 'Hunt</span>', 'Hello', 'BODY', 'Small print', 'Sig line', kit.PAPER, kit.NAVY]) assert.ok(html.includes(s), s);
  assert.ok(kit.emailShell('x', '').includes('Sent with ♥ by Eric via BookHunt'), 'default signature');
});

test('emailkit.ctaRow: escapes the link', () => {
  assert.ok(kit.ctaRow('https://x/?a=1&b="2"', 'Go').includes('https://x/?a=1&amp;b=&quot;2&quot;'));
});

test('every email module uses the shared kit (no private palette / escaper copies)', () => {
  const fs = require('node:fs');
  for (const f of ['src/notify/email.js', 'src/reader.js', 'src/reader-emails.js', 'src/listwatcher.js']) {
    const src = fs.readFileSync(require('node:path').join(__dirname, '..', f), 'utf8');
    assert.ok(!/function (esc|escapeHtml)\(/.test(src), `${f} defines its own escaper`);
    assert.ok(!/const (ACCENT|PAPER) = '#/.test(src), `${f} defines its own palette`);
  }
});
