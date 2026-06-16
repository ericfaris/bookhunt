'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const email = require('../src/notify/email');

const base = {
  recipient: { name: 'Darla Faris', email: 'darla@example.com' },
  book: { title: 'The Hill', author: 'Harriet Clark', cover: 'https://img.example.com/c.jpg',
          description: 'A quiet town with a loud secret.', pushedToKindle: true },
};

test('buildMessage: subject + body carry the title, author, and blurb', () => {
  const m = email.buildMessage(base);
  assert.match(m.subject, /The Hill/);
  assert.match(m.html, /The Hill/);
  assert.match(m.html, /Harriet Clark/);
  assert.match(m.html, /loud secret/);
  assert.match(m.text, /The Hill/);
  assert.match(m.text, /loud secret/);
});

test('buildMessage: never leaks the recipient email into the message body', () => {
  const m = email.buildMessage(base);
  assert.ok(!m.html.includes('darla@example.com'));
  assert.ok(!m.text.includes('darla@example.com'));
});

test('buildMessage: greets the recipient by first name', () => {
  assert.match(email.buildMessage(base).html, /Hi Darla,/);
  const m = email.buildMessage({ recipient: { email: 'x@y.com' }, book: base.book });
  assert.match(m.html, /Hi there,/);
});

test('buildMessage: attaches an http cover as an inline CID image', () => {
  const m = email.buildMessage(base);
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].cid, 'cover@book');
  assert.match(m.html, /cid:cover@book/);
});

test('buildMessage: no cover → no attachment, shows the 📖 placeholder', () => {
  const m = email.buildMessage({ recipient: base.recipient, book: { ...base.book, cover: null } });
  assert.equal(m.attachments.length, 0);
  assert.ok(!m.html.includes('cid:cover@book'));
  assert.match(m.html, /📖/);
});

test('buildMessage: ignores a non-http cover (e.g. data URI)', () => {
  const m = email.buildMessage({ recipient: base.recipient, book: { ...base.book, cover: 'data:image/png;base64,AAAA' } });
  assert.equal(m.attachments.length, 0);
});

test('buildMessage: delivery line reflects whether it was pushed to Kindle', () => {
  assert.match(email.buildMessage(base).html, /on its way to your Kindle/i);
  const m = email.buildMessage({ recipient: base.recipient, book: { ...base.book, pushedToKindle: false } });
  assert.match(m.html, /ready and waiting/i);
});

test('buildMessage: escapes HTML in title and description', () => {
  const m = email.buildMessage({
    recipient: base.recipient,
    book: { title: 'A <b>Bold</b> & "Quoted" Title', description: '<script>alert(1)</script>', pushedToKindle: false },
  });
  assert.ok(!m.html.includes('<b>Bold</b>'));
  assert.ok(m.html.includes('&lt;b&gt;Bold&lt;/b&gt;'));
  assert.ok(!m.html.includes('<script>alert(1)</script>'));
});

test('buildMessage: falls back to filename when there is no title', () => {
  const m = email.buildMessage({ recipient: base.recipient, book: { filename: 'book.epub', pushedToKindle: false } });
  assert.match(m.subject, /book\.epub/);
});
