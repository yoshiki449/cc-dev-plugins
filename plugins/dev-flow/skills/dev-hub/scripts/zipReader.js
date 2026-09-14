'use strict';

const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;

function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('zip: end-of-central-directory not found');
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let p = cdOffset;
  while (p < cdOffset + cdSize) {
    if (buf.readUInt32LE(p) !== CDH_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lfhOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, uncompSize, lfhOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extractEntry(buf, entry) {
  const lfhNameLen = buf.readUInt16LE(entry.lfhOffset + 26);
  const lfhExtraLen = buf.readUInt16LE(entry.lfhOffset + 28);
  const dataStart = entry.lfhOffset + 30 + lfhNameLen + lfhExtraLen;
  const compData = buf.slice(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return compData;
  if (entry.method === 8) return zlib.inflateRawSync(compData);
  throw new Error(`zip: unsupported compression method ${entry.method} for ${entry.name}`);
}

module.exports = { readZipEntries, extractEntry };
