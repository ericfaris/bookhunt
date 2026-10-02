'use strict';

// kindle.pushToKindle with an in-memory buffer (issue #47: books in R2 are
// attached from bytes, not a local path). The file-path branch is pinned by
// test/local-send-characterization.test.js.
const { test } = require('node:test');
const assert = require('node:assert');

const kindle = require('../src/kindle');
const smtp = require('../src/smtp');

async function capture(args) {
  const orig = smtp.getTransport;
  let captured = null;
  smtp.getTransport = () => ({ sendMail: async (m) => { captured = m; } });
  try {
    await kindle.pushToKindle(args);
  } finally {
    smtp.getTransport = orig;
  }
  return captured;
}

test('pushToKindle (buffer): attachment is { filename, content, contentType } with no path', async () => {
  const content = Buffer.from('epub bytes');
  const m = await capture({ kindleEmail: 'k@kindle.com', filename: 'Book.epub', content });
  assert.deepStrictEqual(m.attachments, [{ filename: 'Book.epub', content, contentType: 'application/epub+zip' }]);
  assert.ok(!('path' in m.attachments[0]));
  assert.equal(m.to, 'k@kindle.com');
  assert.equal(m.from, smtp.FROM);
  assert.equal(m.subject, 'Book.epub');
  assert.equal(m.text, 'Sent from BookHunt');
});

test('pushToKindle (buffer): filename defaults to book.epub', async () => {
  const m = await capture({ kindleEmail: 'k@kindle.com', content: Buffer.from('x') });
  assert.equal(m.attachments[0].filename, 'book.epub');
  assert.equal(m.subject, 'book.epub');
});

test('pushToKindle: a non-Buffer content is ignored (falls back to filePath)', async () => {
  const m = await capture({ kindleEmail: 'k@kindle.com', filePath: '/a/b.epub', content: 'not a buffer' });
  assert.deepStrictEqual(m.attachments, [{ filename: 'b.epub', path: '/a/b.epub', contentType: 'application/epub+zip' }]);
});

test('pushToKindle (buffer): still requires a Kindle email', async () => {
  await assert.rejects(() => kindle.pushToKindle({ content: Buffer.from('x') }), /No Kindle email/);
});
