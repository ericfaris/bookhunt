'use strict';

// Build deep-link searches into OTHER book sources, offered when Mobilism finds
// nothing (issue #19). Pure + dependency-free so it runs server-side and is
// unit-tested. We only LINK out here — no scraping or downloading from these
// sources (explicitly out of scope).

/**
 * Given the (possibly spell-corrected) title/author, return a list of
 * `{ name, url }` one-click searches on external sources. Returns [] when there
 * is nothing to search for.
 */
function buildSources({ title = '', author = '' } = {}) {
  const query = [String(title || '').trim(), String(author || '').trim()]
    .filter(Boolean)
    .join(' ')
    .trim();
  if (!query) return [];
  const q = encodeURIComponent(query);
  return [
    { name: 'Anna’s Archive', url: `https://annas-archive.org/search?q=${q}` },
    { name: 'Library Genesis', url: `https://libgen.is/index.php?req=${q}` },
  ];
}

module.exports = { buildSources };
