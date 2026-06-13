'use strict';

const { getSession, enqueue } = require('./searcher');

/** True for amazon.* / a.co / amzn.* links over http(s). Host patterns are
 *  fully anchored so lookalikes like `amzn.evil.com` or `amazon.co.attacker.net`
 *  don't slip through and get navigated to in the shared browser session. */
function isAmazonUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const h = url.hostname.toLowerCase();
    return (
      h === 'a.co' ||
      /^(?:[a-z0-9-]+\.)*amazon\.[a-z]{2,}(?:\.[a-z]{2,})?$/.test(h) || // amazon.com, www.amazon.co.uk
      /^(?:[a-z0-9-]+\.)*amzn\.[a-z]{2,}$/.test(h) // amzn.to, amzn.com
    );
  } catch {
    return false;
  }
}

/**
 * Amazon often serves a "Click the button below to continue shopping" gate
 * before the real product page. Click through it (a couple of attempts).
 */
async function dismissInterstitial(page) {
  for (let i = 0; i < 2; i++) {
    if (await page.$('#productTitle')) return;
    const btn = await page.$(
      'form[action*="validateCaptcha"] button, form[action*="validateCaptcha"] input[type="submit"], button.a-button-text'
    );
    if (!btn) return;
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      btn.click().catch(() => {}),
    ]);
    await page.waitForTimeout(2000);
  }
}

/** Drop subtitle after a colon/dash and any trailing edition/format parenthetical. */
function cleanTitle(t) {
  if (!t) return '';
  let s = t.split(/\s[:–—]\s|:\s/)[0];
  s = s.replace(/\s*[([][^)\]]*\b(edition|kindle|paperback|hardcover|audiobook|audio)\b[^)\]]*[)\]]\s*$/i, '');
  return s.trim();
}

/** Strip role labels like "(Author)" and trailing punctuation. */
function cleanAuthor(a) {
  if (!a) return '';
  return a.replace(/\([^)]*\)/g, '').replace(/[,;]+\s*$/, '').trim();
}

async function run(url) {
  const { page } = await getSession();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await dismissInterstitial(page);

  const data = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const title = clean((document.querySelector('#productTitle') || {}).textContent);
    let author = '';
    const byline = document.querySelector('#bylineInfo');
    if (byline) {
      // Prefer the contributor link whose role label is "(Author)".
      for (const sp of byline.querySelectorAll('.author')) {
        const a = sp.querySelector('a');
        if (a && /author/i.test(sp.textContent)) {
          author = clean(a.textContent);
          break;
        }
      }
      if (!author) {
        const a = byline.querySelector('a');
        if (a) author = clean(a.textContent);
      }
    }
    return { title, author };
  });

  return {
    title: cleanTitle(data.title),
    author: cleanAuthor(data.author),
    rawTitle: data.title,
  };
}

/** Queued so it serializes with searches on the shared browser page. */
function lookup(url) {
  return enqueue(() => run(url));
}

module.exports = { isAmazonUrl, lookup, cleanTitle, cleanAuthor };
