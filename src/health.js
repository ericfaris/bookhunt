'use strict';

// Operational status for the Status/health view: session warmth, download-dir
// usage, and disk free space. The aggregation that the UI consumes
// (`epubStats`) is PURE and unit-tested; the fs/statfs calls fail soft so the
// endpoint never throws.

const fs = require('fs');
const path = require('path');

const EPUB_RE = /\.epub$/i;

/** PURE: from a list of { name, size }, count the .epub files and sum their
 *  bytes. Non-epub files are ignored. */
function epubStats(files) {
  let count = 0;
  let totalBytes = 0;
  for (const f of files || []) {
    if (!f || typeof f.name !== 'string' || !EPUB_RE.test(f.name)) continue;
    count += 1;
    totalBytes += Number.isFinite(f.size) ? f.size : 0;
  }
  return { count, totalBytes };
}

/** Read the download directory and return epub stats. Fails soft to zeros. */
function readDownloadStats(dir) {
  try {
    const names = fs.readdirSync(dir);
    const files = names.map((name) => {
      let size = 0;
      try { size = fs.statSync(path.join(dir, name)).size; } catch { /* ignore */ }
      return { name, size };
    });
    return { exists: true, ...epubStats(files) };
  } catch {
    return { exists: false, count: 0, totalBytes: 0 };
  }
}

/** Best-effort free/total bytes for the filesystem holding `dir`. null when the
 *  platform/Node build doesn't support statfs. */
function freeSpace(dir) {
  try {
    const s = fs.statfsSync(dir);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

module.exports = { epubStats, readDownloadStats, freeSpace };
