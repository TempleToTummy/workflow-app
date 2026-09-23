// Saved views — the pure parts (no next/*, no Prisma; see
// scripts/test-organize.ts).
//
// A saved view is a named query string for a list page. Every list page in the
// app is already fully URL-driven, so a view is just a bookmark the app knows
// about — but the query is sanitized on save to that page's own filter keys,
// so a view can't smuggle arbitrary parameters into somebody else's session
// when it's shared.

export const SAVED_VIEW_PAGES = {
  "/": {
    label: "Dashboard",
    keys: ["q", "view", "due", "period", "assigneeId", "clientId", "projectId", "status", "group", "tag"],
  },
  "/tasks": {
    label: "Tasks",
    keys: ["q", "due", "assigneeId", "clientId", "projectId", "status", "group", "tag"],
  },
} as const;

export type SavedViewPath = keyof typeof SAVED_VIEW_PAGES;

export function isSavedViewPath(path: string): path is SavedViewPath {
  return Object.prototype.hasOwnProperty.call(SAVED_VIEW_PAGES, path);
}

const MAX_VALUE_LENGTH = 200;
export const MAX_VIEW_NAME_LENGTH = 60;
export const MAX_VIEWS_PER_PERSON = 50;

// Keeps only the page's filter keys, drops blanks and over-long values, and
// orders keys canonically so the same filters always produce the same string
// (which is how the menu tells which view is currently applied).
export function sanitizeViewQuery(path: SavedViewPath, raw: string): string {
  const input = new URLSearchParams(raw.startsWith("?") ? raw.slice(1) : raw);
  const out = new URLSearchParams();
  for (const key of SAVED_VIEW_PAGES[path].keys) {
    const value = input.get(key)?.trim();
    if (value && value.length <= MAX_VALUE_LENGTH) out.set(key, value);
  }
  return out.toString();
}

export function normalizeViewName(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) throw new Error("Give the view a name.");
  if (name.length > MAX_VIEW_NAME_LENGTH) {
    throw new Error(`Keep view names under ${MAX_VIEW_NAME_LENGTH} characters.`);
  }
  return name;
}

export function viewHref(path: SavedViewPath, query: string): string {
  return query ? `${path}?${query}` : path;
}
