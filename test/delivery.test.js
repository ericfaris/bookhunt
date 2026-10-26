'use strict';

// src/delivery.js — the send mechanics shared by /api/send, the watcher and
// the reader send — plus smtp.operatorEmail().

const { test } = require('node:test');
const assert = require('node:assert');

const delivery = require('../src/delivery');
const kindle = require('../src/kindle');
const covers = require('../src/covers');
const smtp = require('../src/smtp');

test('attachmentLoader: fetches once for every recipient, failures included', async () => {
  let calls = 0;
  const store = { attachment: async (p) => { calls++; return { filePath: p }; } };
  const get = delivery.attachmentLoader('/downloads/x.epub', store);
  assert.deepEqual(await get(), { filePath: '/downloads/x.epub' });
  await get();
  assert.equal(calls, 1);

  let failCalls = 0;
  const bad = delivery.attachmentLoader('/downloads/y.epub', { attachment: async () => { failCalls++; throw new Error('R2 down'); } });
  await assert.rejects(bad, /R2 down/);
  await assert.rejects(bad, /R2 down/);
  assert.equal(failCalls, 1);
});

test('pushToKindle: ok / error / skipped outcomes, never throws', async (t) => {
  const orig = kindle.pushToKindle;
  t.after(() => { kindle.pushToKindle = orig; });
  const pushes = [];
  kindle.pushToKindle = async (args) => { pushes.push(args); };
  const getAttachment = async () => ({ filePath: '/d/b.epub' });

  assert.deepEqual(await delivery.pushToKindle({ kindleEmail: 'a@kindle.com' }, { filename: 'b.epub', getAttachment }), { ok: true });
  assert.deepEqual(pushes[0], { kindleEmail: 'a@kindle.com', filename: 'b.epub', filePath: '/d/b.epub' });

  assert.deepEqual(await delivery.pushToKindle({ name: 'No Kindle' }, { filename: 'b.epub', getAttachment }),
    { ok: false, skipped: true, error: 'no Kindle email' });

  kindle.pushToKindle = async () => { throw new Error('SMTP refused'); };
  assert.deepEqual(await delivery.pushToKindle({ kindleEmail: 'a@kindle.com' }, { filename: 'b.epub', getAttachment }),
    { ok: false, error: 'SMTP refused' });

  const failing = async () => { throw new Error('fetch failed'); };
  assert.deepEqual(await delivery.pushToKindle({ kindleEmail: 'a@kindle.com' }, { filename: 'b.epub', getAttachment: failing }),
    { ok: false, error: 'fetch failed' });
});

test('fillMissingMeta: one lookup fills cover + blurb; never without an author; never overwrites', async (t) => {
  const orig = covers.resolveMeta;
  t.after(() => { covers.resolveMeta = orig; });
  let calls = 0;
  covers.resolveMeta = async () => { calls++; return { cover: 'https://c/x.jpg', description: 'A blurb.' }; };

  const a = await delivery.fillMissingMeta({ title: 'T', author: 'A', cover: null, description: '' });
  assert.equal(a.cover, 'https://c/x.jpg');
  assert.equal(a.description, 'A blurb.');
  assert.equal(calls, 1);

  const noAuthor = await delivery.fillMissingMeta({ title: 'Whistler', author: '', cover: null, description: '' });
  assert.equal(noAuthor.cover, null);
  assert.equal(calls, 1, 'no title-only lookup');

  const kept = await delivery.fillMissingMeta({ title: 'T', author: 'A', cover: 'https://mine.jpg', description: '' });
  assert.equal(kept.cover, 'https://mine.jpg');
  assert.equal(kept.description, 'A blurb.');

  await delivery.fillMissingMeta({ title: 'T', author: 'A', cover: 'x', description: 'y' });
  assert.equal(calls, 2, 'complete books skip the lookup');

  covers.resolveMeta = async () => { throw new Error('boom'); };
  const soft = await delivery.fillMissingMeta({ title: 'T', author: 'A', cover: null, description: '' });
  assert.equal(soft.cover, null);
});

test('smtp.operatorEmail: first set override, then CF Access, then SMTP identity', () => {
  const env = { WATCH_ALERT_EMAIL: '', WARM_ALERT_EMAIL: 'warm@x', CF_ACCESS_ALLOWED_EMAILS: ' cf@x , other@x', SMTP_FROM: 'from@x', SMTP_USER: 'user@x' };
  assert.equal(smtp.operatorEmail(['WATCH_ALERT_EMAIL', 'WARM_ALERT_EMAIL'], env), 'warm@x');
  assert.equal(smtp.operatorEmail(['WATCH_ALERT_EMAIL'], env), 'cf@x');
  assert.equal(smtp.operatorEmail([], { SMTP_FROM: 'from@x', SMTP_USER: 'user@x' }), 'from@x');
  assert.equal(smtp.operatorEmail([], { SMTP_USER: 'user@x' }), 'user@x');
  assert.equal(smtp.operatorEmail([], {}), '');
});
