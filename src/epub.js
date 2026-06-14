'use strict';

// Minimal, zero-dependency ePUB metadata reader. An ePUB is a ZIP archive, so
// we read just enough of the ZIP structure (End-of-Central-Directory + central
// directory) to locate and decompress two entries — META-INF/container.xml and
// the OPF package document — and pull <dc:title> / <dc:creator> out of the OPF.
// Decompression uses Node's built-in zlib (inflateRawSync), so no extra deps.

const fs = require('fs');
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50; // End of Central Directory
const CDH_SIG = 0x02014b50; // Central Directory file Header
const LFH_SIG = 0x04034b50; // Local File Header

/** Find the End-of-Central-Directory record by scanning backwards for its
 *  signature (it sits at the very end, after an optional ≤64 KB comment). */
function findEOCD(buf) {
  const min = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      return { count: buf.readUInt16LE(i + 10), cdOffset: buf.readUInt32LE(i + 16) };
    }
  }
  return null;
}

/** Walk the central directory into a Map of entry name → header fields. */
function parseCentralDirectory(buf, cdOffset, count) {
  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== CDH_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    entries.set(name, { method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Decompress one entry's bytes (stored=0 or deflate=8), or null on failure. */
function extractEntry(buf, entry) {
  try {
    // The local header repeats name/extra lengths; the data follows them.
    const lh = entry.localOffset;
    if (buf.readUInt32LE(lh) !== LFH_SIG) return null;
    const nameLen = buf.readUInt16LE(lh + 26);
    const extraLen = buf.readUInt16LE(lh + 28);
    const start = lh + 30 + nameLen + extraLen;
    const data = buf.slice(start, start + entry.compSize);
    if (entry.method === 0) return data; // stored
    if (entry.method === 8) return zlib.inflateRawSync(data); // deflate
    return null; // unsupported compression
  } catch {
    return null;
  }
}

/** Decode the handful of XML entities that show up in titles/authors. */
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** First text content of <[ns:]tag>…</[ns:]tag>, entity-decoded, or ''. */
function tagText(xml, tag) {
  const re = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i');
  const m = String(xml || '').match(re);
  return m ? decodeEntities(m[1]) : '';
}

/**
 * Read the embedded metadata from an in-memory ePUB (ZIP) buffer.
 * Returns { ok, title, author, opfPath }. `ok` is false for anything that
 * isn't a readable ZIP with a parseable OPF (truncated file, non-ePUB, etc.).
 */
function parseEpubBuffer(buf) {
  const fail = { ok: false, title: '', author: '', opfPath: '' };
  if (!Buffer.isBuffer(buf)) return fail;
  const eocd = findEOCD(buf);
  if (!eocd) return fail;
  const entries = parseCentralDirectory(buf, eocd.cdOffset, eocd.count);

  // container.xml points at the OPF package document.
  const containerEntry = entries.get('META-INF/container.xml');
  if (!containerEntry) return fail;
  const container = extractEntry(buf, containerEntry);
  if (!container) return fail;
  const rootMatch = container.toString('utf8').match(/full-path=["']([^"']+)["']/i);
  if (!rootMatch) return fail;
  const opfPath = rootMatch[1];

  const opfEntry = entries.get(opfPath);
  if (!opfEntry) return fail;
  const opf = extractEntry(buf, opfEntry);
  if (!opf) return fail;
  const xml = opf.toString('utf8');

  return {
    ok: true,
    title: tagText(xml, 'title'),
    author: tagText(xml, 'creator'),
    opfPath,
  };
}

/**
 * Read the embedded metadata from an ePUB file on disk. Thin wrapper over
 * parseEpubBuffer that loads the file first.
 */
function readEpubMetadata(filePath) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return { ok: false, title: '', author: '', opfPath: '' };
  }
  return parseEpubBuffer(buf);
}

module.exports = {
  readEpubMetadata,
  parseEpubBuffer,
  // exported for unit tests
  findEOCD,
  parseCentralDirectory,
  extractEntry,
  tagText,
  decodeEntities,
};
