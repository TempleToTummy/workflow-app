// Global search — query handling and the highlighted excerpts. No framework,
// no database:
//
//   ./node_modules/.bin/tsx scripts/test-search.ts
import { normalizeQuery, highlight, excerpt, isSearchGroup, MAX_QUERY_LENGTH } from "../src/lib/search";
import { check, section, finish } from "./harness";

section("normalizeQuery");
check("trims and collapses whitespace", normalizeQuery("  acme   ltd "), "acme ltd");
check("a single character is too short", normalizeQuery(" a "), null);
check("empty / missing", [normalizeQuery(""), normalizeQuery(null), normalizeQuery(undefined)], [null, null, null]);
check("capped in length", normalizeQuery("x".repeat(500))?.length, MAX_QUERY_LENGTH);

section("highlight");
check("marks every match, case-insensitively", highlight("Acme and ACME", "acme"), [
  { text: "Acme", match: true },
  { text: " and ", match: false },
  { text: "ACME", match: true },
]);
check("no match → the text unchanged", highlight("Bluepoint", "acme"), [{ text: "Bluepoint", match: false }]);
check("regex characters are literal", highlight("a+b (c)", "+b ("), [
  { text: "a", match: false },
  { text: "+b (", match: true },
  { text: "c)", match: false },
]);
check("match at the very end", highlight("Invoice.pdf", ".pdf"), [
  { text: "Invoice", match: false },
  { text: ".pdf", match: true },
]);
check("whole string", highlight("vip", "VIP"), [{ text: "vip", match: true }]);

section("excerpt");
{
  const long = `${"lorem ipsum ".repeat(20)}the bank reconciliation is waiting on statements ${"dolor sit ".repeat(20)}`;
  const e = excerpt(long, "reconciliation", 30);
  check("contains the match", e.includes("reconciliation"), true);
  check("marked as cut at both ends", e.startsWith("…") && e.endsWith("…"), true);
  check("cut on word boundaries", /…\S/.test(e) && !/\s…$/.test(e), true);
  check("short text is returned whole", excerpt("Call Dana about Q3", "dana"), "Call Dana about Q3");
  check("newlines are flattened", excerpt("line one\n\nline two", "two"), "line one line two");
  check("no match on long text → the opening, cut", excerpt("x ".repeat(200), "zzz", 10).endsWith("…"), true);
}

section("groups");
check("known group", isSearchGroup("emails"), true);
check("unknown group", isSearchGroup("passwords"), false);
check("missing group", isSearchGroup(undefined), false);

finish();
