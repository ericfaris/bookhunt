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
