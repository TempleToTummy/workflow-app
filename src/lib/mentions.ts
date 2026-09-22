// @mention parsing for task comments. Pure, no next/* or Prisma import, so
// scripts/test-discussion.ts can exercise every edge case directly.
//
// The design question was how a mention gets from typed text to a notified
// person. Two options were rejected:
//
//   - Storing a markup form like "@[Dana Ruiz](emp_123)". It survives renames
//     perfectly, but it leaks into every place the body is shown as plain text
//     (the audit summary, an email digest, a CSV export) and a comment a human
//     typed should read as what they typed.
//   - Re-parsing the body on every read. Then renaming an employee silently
//     changes who a six-month-old comment mentioned, and editing a body to
//     drop a name un-notifies somebody who was already told.
//
// So: parse once, at write time, against the employee list as it is then, and
// store the resolved ids in TaskCommentMention. The body stays plain text; the
// mention becomes a fact that happened. Rendering re-runs the matcher purely
// for highlighting, and a highlight that stops matching after a rename is a
// cosmetic loss, not a lost notification.

export type MentionCandidate = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
};

export type MentionMatch = {
  // Character range in the body, for highlighting.
  start: number;
  end: number;
  // The text that was matched, including the leading "@".
  text: string;
  // Null when the @name matched nobody, or matched more than one person
  // ambiguously. Those are left as plain text rather than guessed at.
  employeeId: string | null;
};

// The forms a person can be addressed by, longest first so "@Dana Ruiz" is
// preferred over "@Dana" when both would match at the same position.
//
// Ambiguity is resolved by refusing to resolve: if two employees share a first
// name, "@Dana" matches the text but resolves to nobody, and the composer's
// hint tells the author to use the full name. Notifying the wrong Dana about a
// reviewer handoff is worse than notifying neither.
function buildIndex(candidates: MentionCandidate[]): Map<string, string | null> {
  const index = new Map<string, string | null>();

  const add = (key: string, id: string) => {
    const k = key.toLowerCase();
    if (!k) return;
    if (!index.has(k)) {
      index.set(k, id);
      return;
    }
    // Already claimed by somebody else → ambiguous. Same person twice (e.g.
    // their first name equals their email local part) is not a conflict.
    if (index.get(k) !== id) index.set(k, null);
  };

  for (const c of candidates) {
    const full = `${c.firstName} ${c.lastName}`.trim();
    add(full, c.id);
    // "dana.ruiz" / "dana-ruiz" — how a name reads when someone types it the
    // way a username would look.
    add(full.replace(/\s+/g, "."), c.id);
    add(full.replace(/\s+/g, "-"), c.id);
    add(c.firstName, c.id);
    const local = c.email.split("@")[0] ?? "";
    add(local, c.id);
  }

  return index;
}

// Longest candidate first, so a two-word name wins over its own first word.
function sortedKeys(index: Map<string, string | null>): string[] {
  return [...index.keys()].sort((a, b) => b.length - a.length);
}

// An @name that matches nobody at all. Recognised so the composer can warn the
// author that their mention didn't land — which is the failure that matters,
// because they believe they have just handed the task over. It deliberately
// requires a letter straight after the @ (so "cost @ 150/hr" is not a mention)
// and optionally takes a capitalised second word, so "@Jordan Blake" is
// reported as one unmatched name rather than two.
const UNKNOWN_MENTION = /^@([A-Za-z][A-Za-z0-9._-]*(?:\s+[A-Z][A-Za-z0-9._-]*)?)/;

// A mention has to be at a word boundary: "email@example.com" must not be read
// as a mention of someone called "example".
function isBoundaryBefore(body: string, at: number): boolean {
  if (at === 0) return true;
  return /[\s(\[{<"'`]/.test(body[at - 1]);
}

// After the match, the next character must not continue the name — otherwise
// "@Dana" would match inside "@Danabc".
function isBoundaryAfter(body: string, at: number): boolean {
  if (at >= body.length) return true;
  return !/[A-Za-z0-9._-]/.test(body[at]);
}

// Every @mention in the body, in order, resolved where possible.
export function findMentions(body: string, candidates: MentionCandidate[]): MentionMatch[] {
  const index = buildIndex(candidates);
  const keys = sortedKeys(index);
  const matches: MentionMatch[] = [];
  const lower = body.toLowerCase();

  let i = 0;
  while (i < body.length) {
    const at = body.indexOf("@", i);
    if (at === -1) break;

    if (!isBoundaryBefore(body, at)) {
      i = at + 1;
      continue;
    }

    let matched: { key: string; id: string | null } | null = null;
    for (const key of keys) {
      if (lower.startsWith(key, at + 1) && isBoundaryAfter(body, at + 1 + key.length)) {
        matched = { key, id: index.get(key) ?? null };
        break;
      }
    }

    if (matched) {
      matches.push({
        start: at,
        end: at + 1 + matched.key.length,
        text: body.slice(at, at + 1 + matched.key.length),
        employeeId: matched.id,
      });
      i = at + 1 + matched.key.length;
    } else {
      // Nobody by that name. Recorded with a null employeeId so the composer
      // can say so; it is not highlighted and notifies no one.
      const unknown = UNKNOWN_MENTION.exec(body.slice(at));
      if (unknown) {
        matches.push({
          start: at,
          end: at + unknown[0].length,
          text: unknown[0],
          employeeId: null,
        });
        i = at + unknown[0].length;
      } else {
        i = at + 1;
      }
    }
  }

  return matches;
}

// The employee ids to write TaskCommentMention rows for: resolved, deduped,
// and with the author removed — mentioning yourself is a figure of speech, not
// a notification.
export function resolveMentionedIds(
  body: string,
  candidates: MentionCandidate[],
  authorId: string | null
): string[] {
  const ids = new Set<string>();
  for (const m of findMentions(body, candidates)) {
    if (m.employeeId && m.employeeId !== authorId) ids.add(m.employeeId);
  }
  return [...ids];
}

// The body split into plain and mention segments, for rendering. Unresolved
// mentions come back as `mention: false` so they render as ordinary text —
// highlighting a name the app couldn't match would promise a notification that
// was never sent.
export type MentionSegment = { text: string; mention: boolean };

export function segmentBody(body: string, candidates: MentionCandidate[]): MentionSegment[] {
  const matches = findMentions(body, candidates).filter((m) => m.employeeId);
  if (matches.length === 0) return [{ text: body, mention: false }];

  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start > cursor) segments.push({ text: body.slice(cursor, m.start), mention: false });
    segments.push({ text: m.text, mention: true });
    cursor = m.end;
  }
  if (cursor < body.length) segments.push({ text: body.slice(cursor), mention: false });
  return segments;
}

// One level of threading, enforced here rather than trusted from the caller:
// a reply whose parent is itself a reply is re-parented onto the root. The UI
// renders exactly two levels, so allowing a deeper chain into the database
// would mean storing a conversation nothing could display.
export function resolveParentId(
  requestedParentId: string | null,
  parentOfRequested: string | null
): string | null {
  if (!requestedParentId) return null;
  return parentOfRequested ?? requestedParentId;
}

export const MAX_COMMENT_LENGTH = 5000;
