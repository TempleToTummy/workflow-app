// Covers CSV generation — quoting, the Excel BOM, and the formula-injection
// guard that keeps an export from being an attack on whoever opens it:
//
//   ./node_modules/.bin/tsx scripts/test-export.ts
import { check, section, finish } from "./harness";
import { csvField, toCsv, exportFilename, csvHeaders, UTF8_BOM } from "../src/lib/csv";

section("plain values");
check("a word needs no quoting", csvField("Bookkeeping"), "Bookkeeping");
check("a number", csvField(42), "42");
check("a decimal", csvField(2.25), "2.25");
check("null is an empty cell", csvField(null), "");
check("undefined is an empty cell", csvField(undefined), "");
check("an empty string is an empty cell", csvField(""), "");
check("true reads as Yes", csvField(true), "Yes");
check("false reads as No", csvField(false), "No");
check("NaN is blank, not the word NaN", csvField(NaN), "");
check("Infinity is blank", csvField(Infinity), "");

section("dates are local, not UTC-shifted");
// Going through toISOString() here would print the previous day for anyone
// west of Greenwich — the same trap the due-date code documents.
check("a date renders as yyyy-mm-dd", csvField(new Date(2026, 8, 22, 23, 30)), "2026-09-22");
check("an early-morning date keeps its day", csvField(new Date(2026, 0, 1, 0, 15)), "2026-01-01");

section("RFC 4180 quoting");
// Without this, one comma in a company name destroys every column to its right.
check("a comma forces quotes", csvField("Acme, Inc."), '"Acme, Inc."');
check("a double quote is doubled", csvField('He said "done"'), '"He said ""done"""');
check("a newline forces quotes", csvField("line one\nline two"), '"line one\nline two"');
check("a carriage return forces quotes", csvField("a\r\nb"), '"a\r\nb"');
check("leading whitespace is quoted so it round-trips", csvField("  padded"), '"  padded"');
check("trailing whitespace is quoted too", csvField("padded  "), '"padded  "');
check("an inner tab is quoted", csvField("a\tb"), '"a\tb"');
check("a plain space does not force quotes", csvField("Sales Tax"), "Sales Tax");

section("formula injection");
// A cell beginning with =, +, - or @ is EXECUTED by Excel, Sheets and
// LibreOffice. Client notes are free text typed by people, so without this the
// app is an injection vector into whoever opens the report.
check("a leading = is neutralised", csvField("=1+1"), "'=1+1");
check("the classic payload is neutralised", csvField('=HYPERLINK("http://evil.test","click")'), `"'=HYPERLINK(""http://evil.test"",""click"")"`);
check("a leading + is neutralised", csvField("+441234567890"), "'+441234567890");
check("a leading @ is neutralised", csvField("@SUM(A1:A9)"), "'@SUM(A1:A9)");
check("a leading tab is neutralised", csvField("\t=cmd"), "\"'\t=cmd\"");
check("a leading minus with text is neutralised", csvField("-cmd|' /c calc'!A0"), "'-cmd|' /c calc'!A0");
// A real negative number has to stay numeric for a finance report to add up,
// and a bare number can't carry a payload.
check("a negative number stays numeric", csvField("-42"), "-42");
check("a negative decimal stays numeric", csvField("-42.50"), "-42.50");
check("a negative number as a number stays numeric", csvField(-42), "-42");
check("an inner = is harmless and left alone", csvField("total=42"), "total=42");
check("a name that merely contains @ is left alone", csvField("dana@firm.test"), "dana@firm.test");

section("whole file");
const csv = toCsv(["Client", "Hours", "Note"], [
  ["Acme, Inc.", 2.25, "=cmd"],
  ["Bluepoint", 0, null],
]);
check("starts with the Excel BOM", csv.startsWith(UTF8_BOM), true);
// Without the BOM, Excel on Windows reads the file as the local code page and
// mangles any non-ASCII character in a client's name.
check("rows are CRLF separated", csv.includes("\r\n"), true);
check("the header row", csv.split("\r\n")[0], `${UTF8_BOM}Client,Hours,Note`);
check("a quoted field and a guarded field in one row", csv.split("\r\n")[1], `"Acme, Inc.",2.25,'=cmd`);
check("a zero is written, not blanked", csv.split("\r\n")[2], "Bluepoint,0,");
check("three lines for a header plus two rows", csv.split("\r\n").length, 3);
check("the BOM can be turned off", toCsv(["A"], [["b"]], { bom: false }), "A\r\nb");
check("headers are escaped too", toCsv(["Name, full"], []), `${UTF8_BOM}"Name, full"`);
check("no rows still yields a header", toCsv(["A", "B"], []), `${UTF8_BOM}A,B`);

section("filenames");
const when = new Date(2026, 8, 22);
check("a report name becomes a slug with the date", exportFilename("Project Activity List", when), "project-activity-list-2026-09-22.csv");
check("punctuation collapses to single hyphens", exportFilename("Client / Project — Matrix", when), "client-project-matrix-2026-09-22.csv");
check("an empty label still yields a filename", exportFilename("", when), "export-2026-09-22.csv");
// Nothing user-supplied may reach the Content-Disposition header unescaped.
check("quotes and semicolons are stripped, not escaped", exportFilename('evil"; drop', when), "evil-drop-2026-09-22.csv");
check("newlines cannot get into the header", exportFilename("a\r\nb", when), "a-b-2026-09-22.csv");
check("path separators are stripped", exportFilename("../../etc/passwd", when), "etc-passwd-2026-09-22.csv");

section("response headers");
const headers = csvHeaders("report-2026-09-22.csv");
check("content type declares utf-8", headers["Content-Type"], "text/csv; charset=utf-8");
check("it downloads rather than rendering", headers["Content-Disposition"], 'attachment; filename="report-2026-09-22.csv"');
// An export is a point-in-time snapshot; caching it hands somebody yesterday's
// numbers with today's date on them.
check("exports are never cached", headers["Cache-Control"], "no-store");

finish();
