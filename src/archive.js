'use strict';

// Releases aren't always a bare .epub — they're frequently the EPUB wrapped in a
// ZIP or RAR archive. This module sniffs a downloaded file and, when it's an
// archive, pulls the inner .epub file(s) back out as buffers so the rest of the
// pipeline (verification + send-to-reader) can treat them as a normal ePUB.
//
// ZIP is handled natively by reusing the ZIP primitives in epub.js (no deps).
// RAR (both RAR4 and RAR5) is handled by node-unrar-js, a pure-WASM unrar.

const fs = require('fs');
const { findEOCD, parseCentralDirectory, extractEntry } = require('./epub');

// Magic numbers. An ePUB is itself a ZIP, so we distinguish a *plain ePUB* from
// a *ZIP that wraps an ePUB* by also sniffing the EPUB mimetype signature.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
const RAR_MAGIC = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]); // "Rar!\x1a\x07" (RAR4 + RAR5)

const isEpubEntryName = (name) => /\.epub$/i.test(name || '');

/** Read the first `n` bytes of a file (fewer if the file is shorter). */
function readHead(filePath, n = 64) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    fs.closeSync(fd);
    return buf.slice(0, read);
  } catch {
    return Buffer.alloc(0);
  }
}

/** True when a ZIP's first local entry is the uncompressed EPUB `mimetype`. */
function looksLikeEpub(head) {
  return (
    head.length >= 58 &&
    head.slice(0, 4).equals(ZIP_MAGIC) &&
    head.slice(30, 38).toString('latin1') === 'mimetype' &&
    head.slice(38, 58).toString('latin1') === 'application/epub+zip'
  );
}

/**
 * Classify a downloaded file by content (with an extension fallback):
 *   'epub'  — already a bare ePUB; no extraction needed
 *   'zip'   — a ZIP archive (that is not itself an ePUB)
 *   'rar'   — a RAR archive
 *   'other' — anything else
 */
function sniffArchive(filePath) {
  const head = readHead(filePath);
  if (looksLikeEpub(head)) return 'epub';
  if (head.slice(0, 4).equals(ZIP_MAGIC)) return 'zip';
  if (head.slice(0, 6).equals(RAR_MAGIC)) return 'rar';
  // Magic missing/garbled — fall back to the extension so a mislabeled-but-named
  // archive still gets a chance.
  if (/\.zip$/i.test(filePath)) return 'zip';
  if (/\.rar$/i.test(filePath)) return 'rar';
  if (/\.epub$/i.test(filePath)) return 'epub';
  return 'other';
}

/** Extract every `*.epub` entry from a ZIP buffer → [{ name, data }]. */
function extractEpubsFromZipBuffer(buf) {
  const out = [];
  const eocd = findEOCD(buf);
  if (!eocd) return out;
  const entries = parseCentralDirectory(buf, eocd.cdOffset, eocd.count);
  for (const [name, entry] of entries) {
    if (!isEpubEntryName(name)) continue;
    const data = extractEntry(buf, entry);
    if (data && data.length > 0) out.push({ name, data });
  }
  return out;
}

/** Extract every `*.epub` entry from a RAR buffer → [{ name, data }] (async). */
async function extractEpubsFromRarBuffer(buf) {
  // Lazily required so a missing/broken optional dep never breaks ZIP handling
  // or app startup — only RAR extraction would fail, as one failed mirror.
  const { createExtractorFromData } = require('node-unrar-js');
  // node-unrar-js wants an ArrayBuffer; hand it the buffer's exact slice.
  const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const extractor = await createExtractorFromData({ data });

  const wanted = [];
  for (const h of extractor.getFileList().fileHeaders) {
    if (!h.flags.directory && isEpubEntryName(h.name)) wanted.push(h.name);
  }
  if (!wanted.length) return [];

  const out = [];
  const extracted = extractor.extract({ files: wanted });
  for (const file of extracted.files) {
    if (file.extraction && file.extraction.length > 0) {
      out.push({ name: file.fileHeader.name, data: Buffer.from(file.extraction) });
    }
  }
  return out;
}

/**
 * If `filePath` is a ZIP or RAR archive, return its inner `*.epub` files as
 * [{ name, data }]; otherwise (a bare ePUB or a non-archive) return []. Throws
 * only if an archive is recognized but cannot be opened/decompressed.
 */
async function extractEpubs(filePath) {
  const kind = sniffArchive(filePath);
  if (kind !== 'zip' && kind !== 'rar') return [];
  const buf = fs.readFileSync(filePath);
  return kind === 'zip'
    ? extractEpubsFromZipBuffer(buf)
    : extractEpubsFromRarBuffer(buf);
}

module.exports = {
  sniffArchive,
  extractEpubs,
  // exported for unit tests
  looksLikeEpub,
  extractEpubsFromZipBuffer,
  extractEpubsFromRarBuffer,
};
