'use strict';

// View & cancel pending re-upload REQUESTS (issue #27). Mobilism's UCP page
// `ucp.php?i=reuploads&mode=requests` is the source of truth — local history is
// only "what I asked for through this app" and drifts the moment a request is
// fulfilled / cancelled / expires server-side. So we scrape the live list and
// drive the page's own Mark + Cancel + Submit flow to cancel.
//
// Same shape as src/reupload.js: the pure parse (parseRequestRows) is exported
// and unit-tested without a browser; the Playwright glue is defensive and logs
// the raw page server-side for tuning.

const { getSession, ensureReady, enqueue, randomDelay, BASE_URL } = require('./searcher');

const REQUESTS_URL = `${BASE_URL}/ucp.php?i=reuploads&mode=requests`;

function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * PURE: normalize raw table rows (arrays of cell strings, as extracted from the
 * UCP requests table) into request objects. Skips the header row and any row
 * without a release name. Exported for unit testing.
 *
 * rows: Array<Array<string>>  →  Array<{ releaseName, requestedOn, releaserLastOnline }>
 */
function parseRequestRows(rows) {
  const out = [];
  for (const cells of rows || []) {
    if (!Array.isArray(cells)) continue;
    const releaseName = clean(cells[0]);
    if (!releaseName) continue;
    // Drop the header row ("Release Name | Requested on | Releaser last online").
    if (/^release\s*name$/i.test(releaseName)) continue;
    out.push({
      releaseName,
      requestedOn: clean(cells[1] || ''),
      releaserLastOnline: clean(cells[2] || ''),
    });
  }
  return out;
}

// Normalize for matching a release name across the UI / history / page.
function normName(s) {
  return clean(s).toLowerCase();
}

// --- Playwright glue --------------------------------------------------------

/** List the user's current re-upload requests. Queued behind the shared browser;
 *  requires an authenticated session (ensureReady throws needWarm if stale). */
function listRequests() {
  return enqueue(runListRequests);
}

async function runListRequests() {
  const { page } = await getSession();
  await ensureReady(page);
  await randomDelay();
  await page.goto(REQUESTS_URL, { waitUntil: 'domcontentloaded' });

  const rows = await page
    .$$eval('table tr', (trs) =>
      trs.map((tr) =>
        Array.from(tr.querySelectorAll('th,td')).map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim())
      )
    )
    .catch(() => []);

  const bodyText = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
  console.error('[reuploads] %s\n%s', REQUESTS_URL, bodyText.slice(0, 800));

  return { requests: parseRequestRows(rows) };
}

/** Cancel one or more requests by release name via the page's Mark + Cancel +
 *  Submit flow. Best-effort/defensive: matches checkboxes to rows by release
 *  name, selects a "Cancel"-ish action if present, then submits. */
function cancelRequests(releaseNames) {
  return enqueue(() => runCancel(releaseNames));
}

async function runCancel(releaseNames) {
  const wanted = (releaseNames || []).map(normName).filter(Boolean);
  if (!wanted.length) return { cancelled: 0, message: 'No requests selected.' };

  const { page } = await getSession();
  await ensureReady(page);
  await randomDelay();
  await page.goto(REQUESTS_URL, { waitUntil: 'domcontentloaded' });

  // Tick the checkbox in each row whose release name matches a wanted name.
  const checked = await page
    .evaluate((names) => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const set = new Set(names);
      let n = 0;
      for (const tr of document.querySelectorAll('tr')) {
        const firstCell = tr.querySelector('td');
        const cb = tr.querySelector('input[type="checkbox"]');
        if (firstCell && cb && set.has(norm(firstCell.textContent))) {
          cb.checked = true;
          n++;
        }
      }
      return n;
    }, wanted)
    .catch(() => 0);

  if (!checked) return { cancelled: 0, message: 'No matching requests found to cancel.' };

  // Choose a "Cancel requests" action in the dropdown, if the page uses one.
  await page
    .evaluate(() => {
      for (const sel of document.querySelectorAll('select')) {
        for (const opt of sel.options) {
          if (/cancel/i.test(opt.textContent || '')) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
        }
      }
    })
    .catch(() => {});

  const submit = await page.$('input[type="submit"], button[type="submit"], input[name="submit"]');
  if (submit) {
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      submit.click().catch(() => {}),
    ]);
    await page.waitForTimeout(1000);
  }

  // phpBB may interpose an "Are you sure?" confirm page.
  const confirmBtn = await page.$('input[name="confirm"], button[name="confirm"], input[value="Yes" i]');
  if (confirmBtn) {
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      confirmBtn.click().catch(() => {}),
    ]);
    await page.waitForTimeout(800);
  }

  const bodyText = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
  console.error('[reuploads:cancel] %d marked → %s', checked, bodyText.slice(0, 400));

  return { cancelled: checked, message: `Cancelled ${checked} request${checked === 1 ? '' : 's'}.` };
}

module.exports = {
  listRequests,
  cancelRequests,
  REQUESTS_URL,
  // exported for unit tests
  parseRequestRows,
  normName,
};
