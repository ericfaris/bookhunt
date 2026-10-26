'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const reader = require('../src/reader');
const { requireReader, sendError } = require('../src/routes/http');

function fakeRes() {
  const res = { statusCode: 200, body: undefined, ended: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = () => { res.ended = true; return res; };
  return res;
}

test('requireReader: query token on GET, body token on POST; 404 JSON or empty', (t) => {
  const orig = reader.byToken;
  t.after(() => { reader.byToken = orig; });
  const R = { id: 'r1', name: 'Ann' };
  reader.byToken = (tok) => (tok === 'good-token' ? R : null);

  let req = { method: 'GET', query: { t: 'good-token' } };
  let nexted = false;
  requireReader()(req, fakeRes(), () => { nexted = true; });
  assert.ok(nexted);
  assert.equal(req.reader, R);

  req = { method: 'POST', query: { t: 'good-token' }, body: { t: 'bad' } };
  let res = fakeRes();
  requireReader()(req, res, () => assert.fail('must not pass'));
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'Not found' });

  res = fakeRes();
  requireReader({ json: false })({ method: 'GET', query: {} }, res, () => assert.fail('must not pass'));
  assert.equal(res.statusCode, 404);
  assert.ok(res.ended);
  assert.equal(res.body, undefined);
});

test('sendError: needWarm / notActive → 409 with flag; else 500 with message or fallback', () => {
  let res = fakeRes();
  sendError(res, Object.assign(new Error('stale'), { needWarm: true }));
  assert.deepEqual([res.statusCode, res.body], [409, { error: 'stale', needWarm: true }]);
  res = fakeRes();
  sendError(res, Object.assign(new Error('paused'), { notActive: true }));
  assert.deepEqual([res.statusCode, res.body], [409, { error: 'paused', notActive: true }]);
  res = fakeRes();
  sendError(res, new Error('boom'), 'fallback');
  assert.deepEqual([res.statusCode, res.body], [500, { error: 'boom' }]);
  res = fakeRes();
  sendError(res, null, 'fallback');
  assert.deepEqual([res.statusCode, res.body], [500, { error: 'fallback' }]);
});
