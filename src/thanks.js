'use strict';

// Give thanks to the release poster after a verified download (issue #25).
//
// Mobilism culture runs on thanks — it's how posters get recognition. After we
// successfully download AND verify a book, it's good etiquette to click the
// thread's "Thank You" button on the user's behalf. This is best-effort and
// strictly NON-BLOCKING: a failure here must never fail the download.
//
// Mirrors src/reupload.js: the Playwright-driven scrape (giveThanks) gathers raw
// signals from the page; the decision logic (classifyThanks) is pure so it can
// be unit-tested without a browser. The on-page markup varies by theme, so the
// scrape is defensive and logs the raw page text server-side for tuning.
//
// Target control (an anchor styled as a button):
//   <a href="./viewtopic.php?p=..&thanks=..&to_id=..&from_id=.." class="btn">
//     <i class="icon-thumbs-up"></i> Thank You
//   </a>
// The action `thanks=` param disappears once you've thanked the post, so its
// presence/absence is the most reliable "have I thanked yet?" signal.

const { randomDelay } = require('./searcher');

// Page-text hint that a thanks/thankers block exists ("X users say Thank You to
// <poster>…"). Used only to tell "already thanked" apart from "not available"
// when no active Thank You control is present.
const THANKERS_RE = /say(?:s)?\s+thank\s*you|thanked\s+the\s+(?:author|poster)|following\s+user.*thank/i;

/**
 * Map raw scrape signals to a client-facing outcome + a progress step. Pure —
 * exported for unit testing.
 *
 * signals: { controlFoundBefore, controlFoundAfter, clicked, thankersListPresent }
 * returns: { status, step, message } where
 *   status ∈ 'thanked' | 'already-thanked' | 'not-available' | 'unknown'
 *   step   ∈ 'thanked' | 'thanks-skipped' | 'thanks-failed'
 */
function classifyThanks({ controlFoundBefore, controlFoundAfter, clicked, thankersListPresent } = {}) {
  if (clicked) {
    // A successful thank consumes the action link — it's gone on reload.
    if (!controlFoundAfter) {
      return { status: 'thanked', step: 'thanked', message: 'Thanked the poster — much appreciated! 🙏' };
    }
    return { status: 'unknown', step: 'thanks-failed', message: 'Couldn’t confirm the thanks went through.' };
  }
  if (!controlFoundBefore) {
    // No active control: either we already thanked (a thankers block is shown) or
    // the thread simply doesn't offer one.
    if (thankersListPresent) {
      return { status: 'already-thanked', step: 'thanks-skipped', message: 'Already thanked this poster.' };
    }
    return { status: 'not-available', step: 'thanks-skipped', message: 'No Thank You button on this thread.' };
  }
  // Control was there but we never clicked it (shouldn't normally happen).
  return { status: 'unknown', step: 'thanks-failed', message: 'Couldn’t click the Thank You button.' };
}

// --- Playwright glue --------------------------------------------------------

// Locate the active "Thank You" control on a topic page. Prefer the action href
// (`?…&thanks=…`), then a thumbs-up icon, then the visible "Thank You" text.
// Returns a Playwright element handle or null. Best-effort by design.
async function findThanksControl(page) {
  return page
    .evaluateHandle(() => {
      const wantedText = /thank\s*you/i;
      const candidates = Array.from(document.querySelectorAll('a[href], button'));
      for (const node of candidates) {
        const href = node.getAttribute('href') || '';
        const txt = (node.textContent || '').trim();
        const hasIcon = !!(node.querySelector && node.querySelector('i.icon-thumbs-up, i[class*="thumbs-up"]'));
        // The `thanks=` action param is the strongest signal; icon/text back it up.
        if (/[?&]thanks=/.test(href) || hasIcon || wantedText.test(txt)) return node;
      }
      return null;
    })
    .then((h) => {
      const el = h.asElement();
      if (!el) {
        h.dispose().catch(() => {});
        return null;
      }
      return el;
    });
}

/**
 * Click the thread's "Thank You" button, operating on an ALREADY-AUTHENTICATED
 * page (reused from the download run — caller holds the browser queue lock, so
 * we do NOT enqueue here). Navigates to `topicUrl`, finds the control, clicks it,
 * and confirms the action link is gone afterwards.
 *
 * Best-effort and non-blocking: never throws — every failure resolves to a
 * { status, step, message } result the caller can surface as a progress event.
 */
async function giveThanks(page, topicUrl, onProgress = () => {}) {
  try {
    onProgress({ step: 'thanking' });
    await randomDelay();
    await page.goto(topicUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});

    const control = await findThanksControl(page);
    const controlFoundBefore = !!control;

    let clicked = false;
    if (control) {
      await Promise.all([
        page.waitForLoadState('domcontentloaded').catch(() => {}),
        control.click({ timeout: 10000 }).catch(() => {}),
      ]);
      clicked = true;
      await page.waitForTimeout(1000);
      control.dispose().catch(() => {});
    }

    // After a real thank, the action control is consumed (gone on reload).
    let controlFoundAfter = false;
    if (clicked) {
      const after = await findThanksControl(page);
      controlFoundAfter = !!after;
      if (after) after.dispose().catch(() => {});
    }

    const bodyText = await page
      .evaluate(() => (document.body && document.body.innerText) || '')
      .catch(() => '');
    // Keep the raw page server-side so the selectors can be tuned against real
    // Mobilism responses without leaking anything to the client.
    console.error('[thanks] %s →\n%s', topicUrl, bodyText.slice(0, 400));

    const result = classifyThanks({
      controlFoundBefore,
      controlFoundAfter,
      clicked,
      thankersListPresent: THANKERS_RE.test(bodyText),
    });
    onProgress({ step: result.step, reason: result.message });
    return result;
  } catch (err) {
    // Never let the thanks step affect the download outcome.
    onProgress({ step: 'thanks-failed', reason: 'Thanks step errored (non-blocking).' });
    return { status: 'error', step: 'thanks-failed', message: err.message };
  }
}

module.exports = {
  giveThanks,
  // exported for unit tests
  classifyThanks,
  THANKERS_RE,
};
