import { inflateRawSync } from "node:zlib";

// Just enough of a zip reader to open the export APEX_ZIP produces: stored or
// deflated entries, no encryption, no zip64. Reads the central directory
// rather than walking local headers, because APEX_ZIP (like most writers) may
// leave sizes out of the local header and put them in a trailing descriptor.
// Returns entry name → bytes; folders are skipped.
export function readZip(buf: Buffer): Map<string, Buffer> {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("this isn't a zip file (or it's damaged)");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("the zip's directory is damaged");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;
    if (flags & 0x1) throw new Error(`${name} is encrypted; export it again without a password`);
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("the zip is in zip64 format, which this reader doesn't support; unzip it and pass the folder");
    }
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`${name}: damaged entry`);
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const data = buf.subarray(start, start + compressedSize);

    if (method === 0) entries.set(name, Buffer.from(data));
    else if (method === 8) entries.set(name, inflateRawSync(data));
    else throw new Error(`${name} uses compression method ${method}, which this reader doesn't support`);
  }
  return entries;
}
