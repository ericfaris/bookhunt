'use strict';

// Operational routes: the Status view, user-tunable settings, the radar's Run now.

const express = require('express');

const searcher = require('../searcher');
const downloader = require('../downloader');
const notify = require('../notify');
const kindle = require('../kindle');
const version = require('../version');
const watchlist = require('../watchlist');
const settings = require('../settings');
const lists = require('../lists');
const listwatcher = require('../listwatcher');
const datastore = require('../datastore');
const storage = require('../storage');

const router = express.Router();

// --- Operational status (drives the Status/health view) ---------------------
router.get('/api/status', async (_req, res) => {
  let session = { browser: false, ready: false, loggedIn: false, cfOk: false };
  try {
    session = await searcher.sessionStatus();
  } catch {
    /* leave defaults on a transient error */
  }
  const store = storage.get();
  // Counts are .epub files only: the local dir listing or the R2 key index.
  const st = await store.stats().catch(() => ({ exists: false, count: 0, totalBytes: 0 }));
  const download = { path: store.displayPath(), ...st, disk: store.disk() };
  if (store.mode !== 'local') download.storage = store.healthInfo();
  res.json({
    version: version.info(),
    session,
    download,
    channels: notify.listChannels(),
    kindle: kindle.isConfigured(),
    data: datastore.status(),
    premium: { hasCreds: downloader.hasPremiumCreds() },
    settings: {
      watchCheckIntervalMin: settings.getWatchIntervalMin(),
      watchMinMin: settings.MIN_WATCH_MIN,
      watchMaxMin: settings.MAX_WATCH_MIN,
      listsEnabled: settings.getListsEnabled(),
      listPullIntervalHours: settings.getListPullIntervalHours(),
      listMaxPerRun: settings.getListMaxPerRun(),
      listPerRunMin: settings.MIN_LIST_PER_RUN,
      listPerRunMax: settings.MAX_LIST_PER_RUN,
    },
    lists: (() => {
      const state = lists.readState();
      return {
        configured: lists.isConfigured(),
        lastRunAt: state.lastRunAt,
        watching: watchlist.readAll().filter((w) => w.source === 'list' && w.status === 'active').length,
      };
    })(),
  });
});

// Update user-tunable settings (watchlist cadence + new-release radar).
router.post('/api/settings', (req, res) => {
  const body = req.body || {};
  const out = {};
  if (body.watchCheckIntervalMin !== undefined) {
    out.watchCheckIntervalMin = settings.setWatchIntervalMin(body.watchCheckIntervalMin);
  }
  if (body.listsEnabled !== undefined) {
    out.listsEnabled = settings.setListsEnabled(body.listsEnabled);
  }
  if (body.listPullIntervalHours !== undefined) {
    out.listPullIntervalHours = settings.setListPullIntervalHours(body.listPullIntervalHours);
  }
  if (body.listMaxPerRun !== undefined) {
    out.listMaxPerRun = settings.setListMaxPerRun(body.listMaxPerRun);
  }
  res.json({ ok: true, settings: { watchCheckIntervalMin: settings.getWatchIntervalMin(), ...out } });
});

// --- New-release list radar (issue #33) --------------------------------------
// Manual "Run now" for the radar: pulls the lists immediately regardless of
// cadence. The pull itself is only NYT API calls (no forum traffic), so it's
// safe to run on demand; acquisitions still drain politely via the watcher.
router.post('/api/lists/run', async (_req, res) => {
  try {
    const summary = await listwatcher.run({ force: true });
    res.json({ ok: true, ...summary });
  } catch (err) {
    console.error('List run failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
