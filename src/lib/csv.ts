// CSV generation. Pure, no next/* or Prisma import, so
// scripts/test-export.ts can exercise the escaping rules directly.
//
// All eight reports were read-only HTML, which made them half a report: the
// numbers were visible but couldn't be reconciled against anything, mailed to
// a partner, or opened in a spreadsheet. This is the other half.
//
// Three things here are not optional for a file a firm will open in Excel:
//
//   1. RFC 4180 quoting. A company name with a comma in it ("Acme, Inc.") or a
//      note with a newline silently destroys every column to its right
//      otherwise.
//   2. A UTF-8 BOM. Without it Excel on Windows reads the file as the local
//      code page, and any non-ASCII character in a client's name arrives
//      mangled. Every other consumer ignores a BOM.
//   3. A formula-injection guard. A cell beginning with =, +, - or @ is
//      executed as a formula by Excel, Sheets and LibreOffice. Client notes
//      are free text typed by people, so the app is an injection vector into
//      whatever machine opens the export unless the value is neutralised.
//      This is the one that turns a convenience feature into a security bug if
//      it's left out.

export type CsvValue = string | number | boolean | Date | null | undefined;
export type CsvRow = CsvValue[];

// Characters that make a leading position dangerous in a spreadsheet. Tab and
// carriage return are included because both are treated as leading whitespace
// and skipped, exposing the character behind them.
const FORMULA_LEAD = /^[=+\-@\t\r]/;

// Neutralises a formula lead by prefixing a single quote, which every major
// spreadsheet reads as "the rest is literal text". The quote is inside the
// quoted field, so the raw bytes still round-trip through any CSV parser that
// isn't a spreadsheet.
//
// A plain negative number is left alone: "-42" is data a finance report needs
// to stay numeric, and a bare number can't carry a payload. Anything that
// merely starts like a number but isn't one is still guarded.
function guardFormula(text: string): string {
  if (!FORMULA_LEAD.test(text)) return text;
  if (/^-?\d+(\.\d+)?$/.test(text)) return text;
  return `'${text}`;
}

function renderValue(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    // yyyy-mm-dd in local time. Going through toISOString() would shift the
    // day west of Greenwich, the same trap the due-date code documents.
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return value;
}

// One field, quoted and escaped. Always quoting would be valid too, but it
// makes the file unreadable when it's eyeballed in a terminal, and the whole
// point is that the data can be got out and looked at.
//
// Quoting is triggered by the delimiters RFC 4180 requires it for, and also by
// leading or trailing whitespace: a tab isn't a delimiter in a comma-separated
// file, but plenty of parsers trim unquoted whitespace, and a value that comes
// back trimmed is a value that changed in transit. Quoting makes it
// round-trip exactly.
export function csvField(value: CsvValue): string {
  const guarded = guardFormula(renderValue(value));
  if (guarded === "") return "";
  if (/[",\r\n\t]/.test(guarded) || /^\s|\s$/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

export const UTF8_BOM = "﻿";

// CRLF line endings, as RFC 4180 specifies and as Excel expects.
export function toCsv(headers: string[], rows: CsvRow[], options?: { bom?: boolean }): string {
  const lines = [headers.map(csvField).join(","), ...rows.map((r) => r.map(csvField).join(","))];
  const body = lines.join("\r\n");
  return options?.bom === false ? body : `${UTF8_BOM}${body}`;
}

// A safe download filename: the report's name, the date it was pulled, and
// nothing a header injection could use. Quotes, semicolons, newlines and path
// separators are all stripped rather than escaped, since none of them belong
// in a report name.
export function exportFilename(label: string, now: Date = new Date()): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "export";
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${slug}-${y}-${m}-${d}.csv`;
}

// The response headers for a CSV download. Content-Disposition carries the
// filename through exportFilename(), so nothing user-supplied reaches the
// header unescaped.
export function csvHeaders(filename: string): Record<string, string> {
  return {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    // An export is a point-in-time snapshot of live data; caching it would
    // hand somebody yesterday's numbers with today's date on them.
    "Cache-Control": "no-store",
  };
}
