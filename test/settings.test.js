'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const settings = require('../src/settings');

test('clampWatchMinutes: clamps to [MIN, MAX] and rounds', () => {
  assert.equal(settings.clampWatchMinutes(1), settings.MIN_WATCH_MIN);
  assert.equal(settings.clampWatchMinutes(settings.MAX_WATCH_MIN + 99999), settings.MAX_WATCH_MIN);
  assert.equal(settings.clampWatchMinutes(30), 30);
  assert.equal(settings.clampWatchMinutes(29.6), 30);
});

test('clampWatchMinutes: non-numeric falls back to the default', () => {
  assert.equal(settings.clampWatchMinutes('nope'), settings.DEFAULT_WATCH_MIN);
  assert.equal(settings.clampWatchMinutes(undefined), settings.DEFAULT_WATCH_MIN);
  assert.equal(settings.clampWatchMinutes('x', 45), 45); // non-numeric → provided fallback
});

test('getWatchIntervalMs is the minutes value × 60000', () => {
  assert.equal(settings.getWatchIntervalMs(), settings.getWatchIntervalMin() * 60000);
});

test('bounds are sane (min ≥ 5 min, max ≤ a week)', () => {
  assert.ok(settings.MIN_WATCH_MIN >= 5);
  assert.ok(settings.MAX_WATCH_MIN <= 7 * 24 * 60);
});

// --- per-pull intake cap (radar flood guard) ---------------------------------

test('clampListPerRun: clamps to [MIN, MAX], rounds, and falls back on junk', () => {
  assert.equal(settings.clampListPerRun(0), settings.MIN_LIST_PER_RUN);
  assert.equal(settings.clampListPerRun(settings.MAX_LIST_PER_RUN + 5000), settings.MAX_LIST_PER_RUN);
  assert.equal(settings.clampListPerRun(10), 10);
  assert.equal(settings.clampListPerRun(9.6), 10);
  assert.equal(settings.clampListPerRun('nope'), settings.DEFAULT_LIST_PER_RUN);
  assert.equal(settings.clampListPerRun(undefined, 7), 7); // non-numeric → provided fallback
});

test('per-run bounds are sane (min ≥ 1, default within bounds)', () => {
  assert.ok(settings.MIN_LIST_PER_RUN >= 1);
  assert.ok(settings.DEFAULT_LIST_PER_RUN >= settings.MIN_LIST_PER_RUN);
  assert.ok(settings.DEFAULT_LIST_PER_RUN <= settings.MAX_LIST_PER_RUN);
});
