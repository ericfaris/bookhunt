'use strict';

// Turn raw, technical failures (Playwright timeouts, Cloudflare 524s, login
// rejections, scrape errors) into plain-language, actionable guidance for the
// UI. Pure and dependency-free so it's unit-testable and usable from any
// endpoint; the client just renders the fields it returns.
//
// Returns { message, hint, retryable, needWarm }:
//   message   — what happened, in plain words (one line).
//   hint      — what the user can do next.
//   retryable — true for transient failures (offer a retry), false for terminal
//               ones (the user should change something instead).
//   needWarm  — the Mobilism session needs re-warming (drives the re-warm CTA).

function classifyError(raw, { needWarm = false } = {}) {
  const text = String((raw && raw.message) || raw || '').trim();
  const t = text.toLowerCase();

  // Stale forum session — the single most common recoverable failure.
  if (needWarm || /need ?warm|session expired|could not log in|not logged in/.test(t)) {
    return {
      message: 'Your Mobilism session has expired.',
      hint: 'Click “Re-warm ↗” to sign back in, then try again.',
      retryable: true,
      needWarm: true,
    };
  }

  // Cloudflare bot challenge in the way.
  if (/just a moment|security verification|cloudflare|\bchallenge\b|cf_clearance/.test(t)) {
    return {
      message: 'Cloudflare is challenging our connection to Mobilism.',
      hint: 'Open “Re-warm ↗” to clear the check in the live browser, then retry.',
      retryable: true,
      needWarm: true,
    };
  }

  // Edge/origin timeout (Cloudflare 524) or a slow scrape that ran out of time.
  if (/\b524\b|timed? ?out|timeout|deadline|took too long/.test(t)) {
    return {
      message: 'Mobilism took too long to respond.',
      hint: 'It may be slow right now. Wait a moment and try again.',
      retryable: true,
      needWarm: false,
    };
  }

  // Low-level network / navigation failures.
  if (/net::|econn|enotfound|etimedout|navigation|err_|socket hang up|fetch failed/.test(t)) {
    return {
      message: 'Couldn’t reach Mobilism.',
      hint: 'Check the connection (or whether the site is up) and try again.',
      retryable: true,
      needWarm: false,
    };
  }

  // Premium account / login problems — terminal until the user fixes creds.
  if (/expired/.test(t) && /account/.test(t)) {
    return {
      message: text || 'Your premium account has expired.',
      hint: 'Renew the membership on Mobilism, then download again.',
      retryable: false,
      needWarm: false,
    };
  }
  if (/login (was )?rejected|credential|invalid (user|password)|premium login/.test(t)) {
    return {
      message: 'The premium downloader rejected those credentials.',
      hint: 'Double-check the premium username and password, then retry.',
      retryable: false,
      needWarm: false,
    };
  }

  // Browser couldn't start / profile locked.
  if (/profile.*lock|in use by another|could not start the browser|processsingleton/.test(t)) {
    return {
      message: 'The browser session is busy or couldn’t start.',
      hint: 'Only one operation runs at a time — wait for it to finish, then retry.',
      retryable: true,
      needWarm: false,
    };
  }

  // No usable download surfaced.
  if (/no download|every mirror failed|not found|no such file|unavailable/.test(t)) {
    return {
      message: 'That download isn’t available right now.',
      hint: 'The links may be dead — try “Request re-upload”, or pick another result.',
      retryable: false,
      needWarm: false,
    };
  }

  // Unknown — keep the original text (it's server-controlled) but still guide.
  return {
    message: text || 'Something went wrong.',
    hint: 'Please try again in a moment.',
    retryable: true,
    needWarm: false,
  };
}

module.exports = { classifyError };
