// Client tags — the pure parts. No next/*, no Prisma, so the naming rules are
// covered by scripts/test-organize.ts.
//
// Tags complement Client.groupName: a client belongs to at most one group
// ("Smith Family") but can carry any number of tags ("VIP", "Needs 1099s").

// A fixed palette rather than free colours: every key has a background and
// text pairing that stays readable, and a stored key can't inject CSS.
export const TAG_COLORS = {
  slate: "bg-slate-100 text-slate-700 border-slate-200",
  blue: "bg-blue-50 text-blue-700 border-blue-200",
  green: "bg-emerald-50 text-emerald-700 border-emerald-200",
  amber: "bg-amber-50 text-amber-800 border-amber-200",
  red: "bg-red-50 text-red-700 border-red-200",
  purple: "bg-violet-50 text-violet-700 border-violet-200",
  pink: "bg-pink-50 text-pink-700 border-pink-200",
  teal: "bg-teal-50 text-teal-700 border-teal-200",
} as const;

export type TagColor = keyof typeof TAG_COLORS;
export const TAG_COLOR_KEYS = Object.keys(TAG_COLORS) as TagColor[];

export function isTagColor(value: unknown): value is TagColor {
  return typeof value === "string" && value in TAG_COLORS;
}

export function tagClasses(color: string): string {
  return isTagColor(color) ? TAG_COLORS[color] : TAG_COLORS.slate;
}

export const MAX_TAG_LENGTH = 32;

// Collapses whitespace and trims. Case is preserved for display ("VIP"), but
// two tags that differ only in case are the same tag — see sameTagName.
export function normalizeTagName(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) throw new Error("A tag needs a name.");
  if (name.length > MAX_TAG_LENGTH) {
    throw new Error(`Keep tag names under ${MAX_TAG_LENGTH} characters.`);
  }
  return name;
}

export function sameTagName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// A new tag's colour, derived from its name so the same word always gets the
// same colour on every screen without anyone having to pick one.
export function defaultTagColor(name: string): TagColor {
  let hash = 0;
  for (const ch of name.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return TAG_COLOR_KEYS[hash % TAG_COLOR_KEYS.length];
}
