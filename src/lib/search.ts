// Global search — the pure parts: normalizing what was typed, and cutting a
// readable excerpt around the match. No next/*, no Prisma; covered by
// scripts/test-search.ts.

export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_LENGTH = 100;

export const SEARCH_GROUPS = [
  { key: "clients", label: "Clients" },
  { key: "contacts", label: "Contacts" },
  { key: "projects", label: "Services" },
  { key: "tasks", label: "Tasks" },
  { key: "comments", label: "Comments" },
  { key: "notes", label: "Notes" },
  { key: "files", label: "Files" },
  { key: "emails", label: "Emails" },
] as const;

export type SearchGroupKey = (typeof SEARCH_GROUPS)[number]["key"];

export function isSearchGroup(value: string | undefined): value is SearchGroupKey {
  return SEARCH_GROUPS.some((g) => g.key === value);
}

// Collapses whitespace and trims. Null when there's nothing worth searching
// for — a single letter matches half the database and helps nobody.
export function normalizeQuery(raw: string | null | undefined): string | null {
  const q = (raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
  return q.length >= MIN_QUERY_LENGTH ? q : null;
}

export type Highlighted = { text: string; match: boolean }[];

// Splits text into matched / unmatched runs for <mark>-ing, case-insensitively.
// Done here rather than with a regex built from user input, so a query like
// "a+b" or "(" can't break anything.
export function highlight(text: string, query: string): Highlighted {
  if (!query) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts: Highlighted = [];
  let from = 0;
  while (from <= text.length) {
    const at = lower.indexOf(needle, from);
    if (at < 0) break;
    if (at > from) parts.push({ text: text.slice(from, at), match: false });
    parts.push({ text: text.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false });
  return parts.length ? parts : [{ text, match: false }];
}

// A window of `radius` characters either side of the first match, on word
// boundaries where possible, with an ellipsis marking what was cut. Long
// comments and email bodies are shown as an excerpt rather than in full.
export function excerpt(text: string, query: string, radius = 70): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return flat.length > radius * 2 ? `${flat.slice(0, radius * 2).trimEnd()}…` : flat;
  let start = Math.max(0, at - radius);
  let end = Math.min(flat.length, at + query.length + radius);
  if (start > 0) {
    const space = flat.indexOf(" ", start);
    if (space >= 0 && space < at) start = space + 1;
  }
  if (end < flat.length) {
    const space = flat.lastIndexOf(" ", end);
    if (space > at + query.length) end = space;
  }
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}
