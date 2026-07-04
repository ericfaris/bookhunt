'use strict';

// NYT Books API source (issue #33 Phase 1). Official JSON, free key
// (NYT_API_KEY), lists refresh Wednesdays. The anchor source: when the
// scraped sources break on a markup change, this one keeps working.

const { titleCase, cleanTitle, cleanAuthor } = require('./util');

const LISTS = [
  { id: 'combined-print-and-e-book-fiction', label: 'NYT Combined Print & E-Book Fiction' },
  { id: 'hardcover-fiction', label: 'NYT Hardcover Fiction' },
];

/** PURE: one NYT book row → { title, author } (null for junk rows). NYT
 *  delivers ALL-CAPS titles, so re-case them. */
function normalizeEntry(book) {
  const title = titleCase(cleanTitle((book && book.title) || ''));
  const author = cleanAuthor((book && book.author) || '');
  return title ? { title, author } : null;
}

async function fetchList(listId) {
  const url = `https://api.nytimes.com/svc/books/v3/lists/current/${encodeURIComponent(listId)}.json?api-key=${encodeURIComponent(process.env.NYT_API_KEY || '')}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`NYT API responded ${res.status} for ${listId}`);
  const data = await res.json();
  const books = (data && data.results && data.results.books) || [];
  return books.map(normalizeEntry).filter(Boolean);
}

function sources() {
  const configured = !!process.env.NYT_API_KEY;
  return LISTS.map((l) => ({
    id: l.id,
    label: l.label,
    tag: 'NYT Fiction',
    configured,
    fetch: () => fetchList(l.id),
  }));
}

module.exports = { sources, normalizeEntry, LISTS };
