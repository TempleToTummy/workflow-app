// What an uploaded file is allowed to be, checked against what it actually
// contains — not what its name or the browser says it is.
//
// Pure (no next/*, no Prisma) — covered by scripts/test-encryption.ts.
//
// Three rules, applied to staff uploads and client uploads alike:
//
//   1. Allow-list by extension. Documents, spreadsheets, images, PDFs and bank
//      exports — the formats an accounting firm actually receives. Nothing that
//      executes, nothing a browser would render as a page (html, svg, xml).
//   2. The bytes must match the extension ("magic number" check). A renamed
//      .exe, an HTML page called invoice.pdf, or a polyglot that starts with a
//      script is refused even though its name passes rule 1.
//   3. The stored content type comes from the extension on this list, never
//      from the upload. The browser-reported MIME type is attacker-controlled.
//
// Downloads are then always served as attachments with nosniff and a
// sandboxing CSP (src/app/api/documents/[id]/route.ts), so even a file that
// slipped through could not run in the app's origin.

type Rule = { mime: string; verify: (b: Buffer) => boolean };

const startsWith = (b: Buffer, sig: number[], at = 0) =>
  b.length >= at + sig.length && sig.every((byte, i) => b[at + i] === byte);
const ascii = (s: string) => Array.from(Buffer.from(s, "latin1"));

const PDF = (b: Buffer) => b.subarray(0, 1024).includes(Buffer.from("%PDF-", "latin1"));
const PNG = (b: Buffer) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = (b: Buffer) => startsWith(b, [0xff, 0xd8, 0xff]);
const GIF = (b: Buffer) => startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a"));
const WEBP = (b: Buffer) => startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8);
const TIFF = (b: Buffer) => startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a]);
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "avif"]);
const HEIC = (b: Buffer) =>
  b.length >= 12 && startsWith(b, ascii("ftyp"), 4) && HEIC_BRANDS.has(b.subarray(8, 12).toString("latin1"));
// Legacy Office (doc, xls): the OLE2 compound-file header.
const OLE2 = (b: Buffer) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
// Office Open XML and OpenDocument are zip containers. An empty zip
// (PK\x05\x06) is refused — there's nothing in it worth sending.
const ZIP = (b: Buffer) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]);

// Things that must never be accepted as "text": a page a browser would render,
// or something a shell or OS would run.
const DANGEROUS_TEXT = /^\s*(<!doctype\s+html|<html|<script|<svg|<\?php|#!)/i;

function isPlainText(b: Buffer): boolean {
  const head = b.subarray(0, 64 * 1024);
  if (head.includes(0)) return false; // binary
  // Strip a UTF-8 BOM before looking for markup at the start.
  const text = head.toString("utf8").replace(/^﻿/, "");
  return !DANGEROUS_TEXT.test(text);
}

// OFX 1.x is SGML with an "OFXHEADER:" preamble; OFX 2.x / QFX / QBO are XML
// with an <OFX> root. Either way it's text, and it must actually be OFX.
const OFX = (b: Buffer) => isPlainText(b) && /OFXHEADER|<OFX>/i.test(b.subarray(0, 4096).toString("utf8"));

const RULES: Record<string, Rule> = {
  pdf: { mime: "application/pdf", verify: PDF },
  png: { mime: "image/png", verify: PNG },
  jpg: { mime: "image/jpeg", verify: JPEG },
  jpeg: { mime: "image/jpeg", verify: JPEG },
  gif: { mime: "image/gif", verify: GIF },
  webp: { mime: "image/webp", verify: WEBP },
  tif: { mime: "image/tiff", verify: TIFF },
  tiff: { mime: "image/tiff", verify: TIFF },
  heic: { mime: "image/heic", verify: HEIC },
  heif: { mime: "image/heif", verify: HEIC },
  csv: { mime: "text/csv", verify: isPlainText },
  txt: { mime: "text/plain", verify: isPlainText },
  doc: { mime: "application/msword", verify: OLE2 },
  xls: { mime: "application/vnd.ms-excel", verify: OLE2 },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", verify: ZIP },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", verify: ZIP },
  odt: { mime: "application/vnd.oasis.opendocument.text", verify: ZIP },
  ods: { mime: "application/vnd.oasis.opendocument.spreadsheet", verify: ZIP },
  zip: { mime: "application/zip", verify: ZIP },
  ofx: { mime: "application/x-ofx", verify: OFX },
  qfx: { mime: "application/x-ofx", verify: OFX },
  qbo: { mime: "application/x-ofx", verify: OFX },
};

export const ALLOWED_UPLOAD_EXTENSIONS = Object.keys(RULES);

// The HTML `accept` attribute for the file pickers, so the OS dialog offers
// only what will be accepted.
export const UPLOAD_ACCEPT = ALLOWED_UPLOAD_EXTENSIONS.map((e) => `.${e}`).join(",");

// 15 MB, matching serverActions.bodySizeLimit in next.config.ts. A cap above
// that limit would fail confusingly inside the framework instead of giving a
// sentence the person can act on.
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

// Content type to store and serve for a filename. Unknown → a generic binary
// type that no browser will try to render.
export function mimeTypeFor(filename: string): string {
  return RULES[fileExtension(filename)]?.mime ?? "application/octet-stream";
}

// A display name that is safe to store, show and put in a download header:
// no directory parts, no control characters, no Unicode direction overrides
// (the "invoice‮fdp.exe" trick that makes an .exe display as .pdf), and
// a bounded length that keeps the extension.
export function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFC")
    // C0/C1 controls, and bidi/zero-width formatting characters.
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/["<>|:*?]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (!cleaned) return "file";
  if (cleaned.length <= 180) return cleaned;
  const ext = fileExtension(cleaned);
  const keep = ext ? `.${ext}` : "";
  return cleaned.slice(0, 180 - keep.length) + keep;
}

export type UploadCheck = { ok: true; filename: string; mimeType: string } | { ok: false; reason: string };

// Name and size, before the bytes are read. Messages are written for a
// client, not for staff: they say what to do next and never mention internals.
export function checkUpload(file: { name: string; size: number }): UploadCheck {
  if (file.size <= 0) {
    return { ok: false, reason: "That file appears to be empty. Please choose another." };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      reason: `Files need to be under ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB. Please send larger files in separate parts.`,
    };
  }
  const filename = safeFilename(file.name);
  const ext = fileExtension(filename);
  if (!ext) {
    return { ok: false, reason: "That file has no extension, so we can't tell what it is." };
  }
  if (!RULES[ext]) {
    return {
      ok: false,
      reason: `We can't accept .${ext} files. Documents, spreadsheets, images and PDFs are fine.`,
    };
  }
  return { ok: true, filename, mimeType: RULES[ext].mime };
}

// The bytes, once read. Run after checkUpload.
export function checkContent(filename: string, bytes: Buffer): UploadCheck {
  if (bytes.length === 0) return { ok: false, reason: "That file appears to be empty. Please choose another." };
  if (bytes.length > MAX_UPLOAD_BYTES) return checkUpload({ name: filename, size: bytes.length });
  const ext = fileExtension(filename);
  const rule = RULES[ext];
  if (!rule) return checkUpload({ name: filename, size: bytes.length });
  if (!rule.verify(bytes)) {
    return {
      ok: false,
      reason: `That file doesn't look like a real .${ext} file. Please export or save it again and send that copy.`,
    };
  }
  return { ok: true, filename, mimeType: rule.mime };
}
