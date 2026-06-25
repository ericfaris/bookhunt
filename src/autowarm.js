'use strict';

// Keeps the Mobilism session authenticated WITHOUT a human in the loop.
//
// A headed browser (which is what we run under Xvfb) usually passes Cloudflare's
// JS/Turnstile challenge on its own, and the login form is just env credentials —
// so the vast majority of re-warms happen silently here, with no /warm visit and
// no password typed into noVNC. The ONLY case that still needs a person is an
// interactive Cloudflare challenge; when searcher.warmUp() reports that, we email
// the operator a /warm link and back off so they can solve it uninterrupted.

const searcher = require('./searcher');
const smtp = require('./smtp');

const CHECK_MS = Number(process.env.AUTO_WARM_INTERVAL_MS) || 20000;
// After an interactive-Cloudflare block, stop auto-navigating for this long so a
// human can solve the challenge in /warm without the watcher yanking the page out
// from under them. Once they clear it, the next tick logs in automatically.
const BLOCK_BACKOFF_MS = Number(process.env.AUTO_WARM_BACKOFF_MS) || 90000;
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://bookhunt.mooseflip.com').replace(/\/$/, '');

let _inFlight = false;
let _backoffUntil = 0;
let _notifiedSinceBlocked = false; // dedupe: at most one alert per block episode

// Who to ping when a human is required. Prefer an explicit WARM_ALERT_EMAIL, else
// the first Cloudflare-Access allowed email, else whatever the SMTP sender is.
function alertEmail() {
  const allowed = (process.env.CF_ACCESS_ALLOWED_EMAILS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return process.env.WARM_ALERT_EMAIL || allowed[0] || process.env.SMTP_FROM || process.env.SMTP_USER || '';
}

async function notifyHumanNeeded(action) {
  if (_notifiedSinceBlocked) return; // already alerted for this episode
  _notifiedSinceBlocked = true;
  const to = alertEmail();
  if (!smtp.isConfigured() || !to) {
    console.warn('[autowarm] human needed but no email is configured to alert');
    return;
  }
  const warmUrl = `${PUBLIC_URL}/warm`;
  try {
    await smtp.getTransport().sendMail({
      from: smtp.FROM,
      to,
      subject: '🔐 Mobilism needs you — Cloudflare challenge',
      text:
        `The Mobilism session can't re-warm itself (${action}).\n\n` +
        `Open ${warmUrl} and clear the Cloudflare challenge once. The app handles ` +
        `the login automatically from there — you don't need to type the password.`,
      html:
        `<p>The Mobilism session can't re-warm itself (<code>${action}</code>).</p>` +
        `<p><a href="${warmUrl}">Open /warm</a> and clear the Cloudflare challenge once. ` +
        `The app handles the login automatically from there — no password to type.</p>`,
    });
    console.log(`[autowarm] alerted ${to}: a human is needed (${action})`);
  } catch (err) {
    console.warn('[autowarm] alert email failed:', err.message);
  }
}

async function tick() {
  if (_inFlight) return; // don't stack attempts
  _inFlight = true;
  try {
    const st = await searcher.sessionStatus(); // passive cookie read — no navigation
    if (!st.browser) return; // browser hasn't launched yet
    if (st.loggedIn) {
      _backoffUntil = 0;
      _notifiedSinceBlocked = false;
      return;
    }
    if (Date.now() < _backoffUntil) return; // a human is mid-solve in /warm — leave them be

    const result = await searcher.warmUp(); // queued: never collides with a search
    if (result.ready) {
      _backoffUntil = 0;
      _notifiedSinceBlocked = false;
      if (result.action !== 'already') console.log(`[autowarm] session re-warmed automatically (${result.action})`);
    } else if (result.humanNeeded) {
      _backoffUntil = Date.now() + BLOCK_BACKOFF_MS;
      console.warn(`[autowarm] human needed (${result.action}) — backing off ${BLOCK_BACKOFF_MS / 1000}s`);
      await notifyHumanNeeded(result.action);
    }
  } catch (err) {
    console.warn('[autowarm] tick failed:', err.message);
  } finally {
    _inFlight = false;
  }
}

let _timer = null;
function start() {
  if (process.env.AUTO_WARM === 'false') {
    console.log('[autowarm] disabled (AUTO_WARM=false)');
    return;
  }
  if (_timer) return;
  _timer = setInterval(tick, CHECK_MS);
  if (_timer.unref) _timer.unref(); // don't keep the process alive just for this
  console.log(
    `[autowarm] watching session every ${CHECK_MS / 1000}s — auto-login on; ` +
      '/warm only needed for an interactive Cloudflare challenge'
  );
}

module.exports = { start, tick };
