'use strict';

// Request a re-upload of a book from its Mobilism topic.
//
// Mobilism download links go stale (filehost banned, file removed). The forum
// provides a "Reupload" control on a topic that pings the original poster to
// re-upload the file. This module drives that control using the app's existing
// authenticated forum session (ensureReady) and classifies the outcome into a
// small, client-friendly set of states.
//
// The Playwright-driven scrape (runReupload) gathers raw signals from the page;
// the decision logic (scanReuploadText + classifyReupload) is pure so it can be
// unit-tested without a browser. The on-page markup can vary, so the scrape is
// deliberately defensive and logs the raw page text server-side for tuning.

const { getSession, ensureReady, enqueue, randomDelay } = require('./searcher');

// Page-text patterns. Mobilism's re-upload plugin flashes a confirmation or a
// "you already asked" / cooldown message after the action; match broadly since
// the exact wording varies by theme/plugin version.
const ALREADY_RE =
  /(already\s+(been\s+)?(requested|asked|submitted)|re-?up(load)?\s+(already|pending)|pending\s+re-?up|request\s+is\s+pending|you\s+can\s+(request|ask).*again|wait\b.*\bbefore\b.*\b(request|re-?up))/i;
const SUCCESS_RE =
  /(re-?up(load)?\s+request|uploader\s+(has\s+been|will\s+be)\s+notified|request\s+(has\s+been\s+)?(sent|submitted|received|recorded)|thank\s*you|notification\s+(has\s+been\s+)?sent)/i;

/**
 * Reduce a page's body text to the boolean signals the classifier needs.
 * Pure — exported for unit testing. `alreadyRequested` wins over `success`
 * because some themes show both a generic thank-you and the cooldown notice.
 */
function scanReuploadText(text) {
  const t = String(text || '');
  const alreadyRequested = ALREADY_RE.test(t);
  return {
    alreadyRequested,
    success: !alreadyRequested && SUCCESS_RE.test(t),
  };
}

/**
 * Map raw scrape signals to a client-facing outcome. Pure — exported for tests.
 *
 * signals: { controlFound, alreadyRequested, success }
 * returns: { status, message } where status is one of
 *   'success' | 'already-requested' | 'not-available' | 'unknown'
 * (the 'needWarm' outcome is produced by the endpoint when ensureReady throws,
 * not here — there's no page to scrape in that case.)
 */
function classifyReupload({ controlFound, alreadyRequested, success } = {}) {
  if (alreadyRequested) {
    return {
      status: 'already-requested',
      message:
        'A re-upload has already been requested for this book — the uploader has been notified. Check back later.',
    };
  }
  if (success) {
    return {
      status: 'success',
      message: 'Re-upload requested — the uploader has been notified.',
    };
  }
  if (!controlFound) {
    return {
      status: 'not-available',
      message:
        'No re-upload option is available on this thread — it may not be eligible, or the links may still be live.',
    };
  }
  // We clicked something but couldn't confirm the result from the page text.
  return {
    status: 'unknown',
    message:
      'Couldn’t confirm the re-upload request. Open the thread to check, or try again in a moment.',
  };
}

// --- Playwright glue --------------------------------------------------------

// Locate the re-upload control on a topic page. Mobilism renders it as a link
// or button near each post; match on the visible text and on a reupload-ish
// href. Returns a Playwright handle or null. Best-effort by design.
async function findReuploadControl(page) {
  return page
    .evaluateHandle(() => {
      const wanted = /re-?up(load|loaded|loading)?\b|request\s+re-?up/i;
      const candidates = Array.from(
        document.querySelectorAll('a[href], button, input[type="submit"], input[type="button"]')
      );
      for (const elNode of candidates) {
        const txt = (elNode.textContent || elNode.value || '').trim();
        const href = elNode.getAttribute('href') || '';
        if (wanted.test(txt) || /re-?up(load)?/i.test(href)) return elNode;
      }
      return null;
    })
    .then((h) => {
      // evaluateHandle returns a JSHandle even for null; resolve to an element
      // handle only when it actually wraps an element.
      const el = h.asElement();
      if (!el) {
        h.dispose().catch(() => {});
        return null;
      }
      return el;
    });
}

/**
 * Submit a re-upload request for a topic. Queued behind the shared browser so it
 * doesn't collide with searches/downloads. Requires an authenticated session
 * (ensureReady throws a typed needWarm error when the session is stale, which
 * the endpoint maps to a "re-warm" prompt).
 *
 * Returns { status, message } from classifyReupload.
 */
function requestReupload(topicUrl) {
  return enqueue(() => runReupload(topicUrl));
}

async function runReupload(topicUrl) {
  const { page } = await getSession();
  await ensureReady(page); // forum login required; throws needWarm if stale

  await randomDelay();
  await page.goto(topicUrl, { waitUntil: 'domcontentloaded' });

  const control = await findReuploadControl(page);

  // No control: the page may already say a request is pending, otherwise the
  // option simply isn't offered here.
  if (!control) {
    const bodyText = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
    const signals = scanReuploadText(bodyText);
    return classifyReupload({ controlFound: false, ...signals });
  }

  await control.click({ timeout: 10000 }).catch(() => {});
  control.dispose().catch(() => {});

  // The action may navigate or post via JS; give it a beat, then handle a phpBB
  // confirmation page ("Are you sure?") by submitting its Yes/confirm button.
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1500);
  const confirmBtn = await page.$('input[name="confirm"], button[name="confirm"], input[value="Yes" i]');
  if (confirmBtn) {
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      confirmBtn.click().catch(() => {}),
    ]);
    await page.waitForTimeout(1000);
  }

  const bodyText = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
  // Keep the raw page server-side so the selectors/patterns can be tuned against
  // real Mobilism responses without leaking anything to the client.
  console.error('[reupload] %s →\n%s', topicUrl, bodyText.slice(0, 800));
  const signals = scanReuploadText(bodyText);
  return classifyReupload({ controlFound: true, ...signals });
}

module.exports = {
  requestReupload,
  // exported for unit tests
  scanReuploadText,
  classifyReupload,
};
