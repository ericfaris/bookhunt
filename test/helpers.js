'use strict';

// Shared test fixtures. NOT named *.test.js, so the `node --test test/*.test.js`
// glob won't try to run it as a test file.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Minimal STORED-zip builder (no compression; crc left 0 — readers here don't
// validate it). Entry order is preserved, which matters for ePUB: putting
// `mimetype` first makes the file pass the byte-offset mimetype sniff too.
function storedZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(0, 8); // stored
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(body.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(Buffer.concat([lh, nameBuf, body]));

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0, 10); // stored
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(body.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, nameBuf]));

    offset += lh.length + nameBuf.length + body.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

function opfXml(title, author) {
  return `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title>
    <dc:creator>${author}</dc:creator>
  </metadata>
</package>`;
}

// A real, valid ePUB buffer: `mimetype` first (so it also passes the byte-offset
// mimetype sniff), then container.xml + OPF, padded past the 1 KB size floor.
function epubBuffer(title = 'Untitled', author = 'Unknown') {
  return storedZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: opfXml(title, author) },
    { name: 'pad.bin', data: Buffer.alloc(1500, 0x20) },
  ]);
}

function writeTmp(name, buf) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'epubtest-')), name);
  fs.writeFileSync(p, buf);
  return p;
}

function writeEpub(name, title, author) {
  return writeTmp(name, epubBuffer(title, author));
}

module.exports = { storedZip, epubBuffer, writeEpub, writeTmp, CONTAINER, opfXml };
