'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const gma = require('../src/listsources/gma');

// Promo embed as the GMA shop article ships it (JSON inside a <script>).
function promo(n, title, brand = 'Bookshop.org') {
  return `{"name":"CommercePromo","props":{"ecm_item_title":"${title}","ecm_item_type":"product","ecm_brand":"${brand}","ecm_url":"https://example.test/x","ecm_object_id":"81520726-${n}"}}`;
}

test('parseHeadline: splits "Title by Author" and drops the GMA Pick / A Novel noise', () => {
  assert.deepEqual(gma.parseHeadline('Whale Harbor: A Novel by Mary Beth Keane'), { title: 'Whale Harbor', author: 'Mary Beth Keane' });
  assert.deepEqual(gma.parseHeadline('Country People: A GMA Book Club Pick by Daniel Mason'), { title: 'Country People', author: 'Daniel Mason' });
  assert.deepEqual(gma.parseHeadline('Yesteryear A Novel by Caro Claire Burke'), { title: 'Yesteryear', author: 'Caro Claire Burke' });
});

test('parseHeadline: decodes entities, strips quote wrapping, tolerates a missing author', () => {
  assert.deepEqual(gma.parseHeadline('The Secret Lives of Murderers&#x27; Wives by Elizabeth Arnott'), { title: "The Secret Lives of Murderers' Wives", author: 'Elizabeth Arnott' });
  assert.deepEqual(gma.parseHeadline("&#x27;Happiness Falls&#x27; by Angie Kim"), { title: 'Happiness Falls', author: 'Angie Kim' });
  assert.deepEqual(gma.parseHeadline('Atmosphere: A Love Story'), { title: 'Atmosphere', author: '' });
  assert.equal(gma.parseHeadline('   '), null);
});

test('parse: reads the monthly run in order, newest first', () => {
  const html = `<script>${promo(3, 'Whale Harbor: A Novel by Mary Beth Keane')}${promo(4, 'Bad Words: A Novel by Rioghnach Robinson')}${promo(5, 'Under Story by Chloe Benjamin')}</script>`;
  assert.deepEqual(gma.parse(html), [
    { title: 'Whale Harbor', author: 'Mary Beth Keane' },
    { title: 'Bad Words', author: 'Rioghnach Robinson' },
    { title: 'Under Story', author: 'Chloe Benjamin' },
  ]);
});

test('parse: stops at the first gap so the best-of section below the monthly run is ignored', () => {
  const html = `<script>${promo(3, 'Whale Harbor by A One')}${promo(4, 'Bad Words by B Two')}${promo(41, "'Happiness Falls' by Angie Kim")}${promo(42, "'Family Lore' by Elizabeth Acevedo")}</script>`;
  const out = gma.parse(html);
  assert.deepEqual(out.map((x) => x.title), ['Whale Harbor', 'Bad Words']);
});

test('parse: caps at MAX_MONTHS picks', () => {
  let html = '<script>';
  for (let n = 3; n < 3 + gma.MAX_MONTHS + 5; n++) html += promo(n, `Book ${n} by Author ${n}`);
  html += '</script>';
  assert.equal(gma.parse(html).length, gma.MAX_MONTHS);
});

test('parse: ignores promos from other articles and returns [] when nothing matches', () => {
  const other = promo(3, 'Other Article Book by Someone').replace('81520726-3', '99999999-3');
  assert.deepEqual(gma.parse(`<script>${other}</script>`), []);
  assert.deepEqual(gma.parse('<html>no promos</html>'), []);
  assert.deepEqual(gma.parse(''), []);
});

test('fetchPicks: rejects on non-OK and on a zero-pick parse, resolves on a valid body', async () => {
  const savedFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: false, status: 503, text: async () => '' });
    await assert.rejects(gma.fetchPicks(), /responded 503/);

    global.fetch = async () => ({ ok: true, status: 200, text: async () => '<html>bot page</html>' });
    await assert.rejects(gma.fetchPicks(), /parsed to 0 picks/);

    global.fetch = async () => ({ ok: true, status: 200, text: async () => `<script>${promo(3, 'Skylark: A Novel by Paula McLain')}</script>` });
    assert.deepEqual(await gma.fetchPicks(), [{ title: 'Skylark', author: 'Paula McLain' }]);
  } finally {
    global.fetch = savedFetch;
  }
});

test('sources: one curated source, tagged, configured, priority 2', () => {
  const s = gma.sources();
  assert.equal(s.length, 1);
  assert.equal(s[0].id, 'gma-book-club');
  assert.equal(s[0].tag, 'GMA Book Club');
  assert.equal(s[0].configured, true);
  assert.equal(s[0].priority, 2);
  assert.equal(typeof s[0].fetch, 'function');
});
