'use strict';

// A fake Playwright page that plays Mobilism for searcher.search(): search URLs
// return canned topic rows (keyed by the `keywords` param), topic URLs return
// canned post content. Records every URL loaded so tests can assert which
// passes ran. `loggedOutLoads` makes the first N page loads look logged out
// (a dead server-side session).

const { BASE_URL } = require('../src/searcher');

function topicUrl(t) {
  return `${BASE_URL}/viewtopic.php?f=1294&t=${t}`;
}

function createFakeForum({ searches = {}, topics = {}, loggedOutLoads = 0 } = {}) {
  const visits = [];
  let current = null;
  let loggedOut = loggedOutLoads;
  let pageLoggedIn = true;

  const page = {
    visits,
    isClosed: () => false,
    async goto(url) {
      visits.push(url);
      current = url;
      pageLoggedIn = loggedOut > 0 ? (loggedOut--, false) : true;
    },
    async evaluate(fn) {
      const src = String(fn);
      if (src.includes('mode=logout')) return pageLoggedIn; // isLoggedIn probe
      if (src.includes('div.content')) {
        const t = topics[new URL(current).searchParams.get('t')];
        if (!t) return null;
        return { url: current, title: t.title, cover: null, text: t.text, links: t.links || [], premium: !!t.premium };
      }
      return undefined; // window.stop() on cancel
    },
    async $$eval(selector) {
      if (!selector.includes('topictitle')) return [];
      const u = new URL(current);
      const rows = searches[u.searchParams.get('keywords')] || [];
      return rows.map(([title, t]) => ({ title, href: topicUrl(t), date: null, category: 'eBooks' }));
    },
    async $eval() { throw new Error('no element'); }, // no "next page" link
    async title() { return 'Mobilism'; },
    async $() { return null; },
    async fill() {}, async check() {}, async click() {},
    async waitForSelector() {}, async waitForTimeout() {},
  };
  const context = {
    async cookies() { return [{ name: 'phpbb3_mobilism_u', value: '12345' }]; }, // logged-in cookie
    async close() {},
  };
  const searchedFor = () => visits
    .filter((v) => v.includes('search.php'))
    .map((v) => new URL(v).searchParams.get('keywords'));
  return { page, context, visits, searchedFor };
}

module.exports = { createFakeForum, topicUrl };
